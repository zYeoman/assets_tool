import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	PluginSettingTab,
	Setting,
	SearchComponent,
} from "obsidian";
import { format } from "date-fns/format";
import { parse } from "date-fns/parse";
import { add } from "date-fns/add";
import { isAfter } from "date-fns/isAfter";
// Remember to rename these classes and interfaces!

interface ToolKitSettings {
	mySetting: string;
	renaming: boolean;
	dateFormat: string;
	headerUpdated: string;
	minMinutesBetweenSaves: number;
	// Union because of legacy
	ignoreGlobalFolder?: string | string[];
}

const DEFAULT_SETTINGS: ToolKitSettings = {
	mySetting: "default",
	renaming: false,
	dateFormat: "yyyy-MM-dd'T'HH:mm",
	headerUpdated: "modified",
	minMinutesBetweenSaves: 1,
	ignoreGlobalFolder: [],
};
function isImage(file: TFile): boolean {
	const IMAGE_EXTS = [
		"jpg",
		"jpeg",
		"png",
		"webp",
		"heic",
		"tif",
		"tiff",
		"bmp",
		"svg",
		"gif",
		"mov",
	];
	return IMAGE_EXTS.includes(file.extension.toLowerCase());
}

function isTFile(value: TAbstractFile): value is TFile {
	return "stat" in value;
}

export default class ToolKitPlugin extends Plugin {
	settings: ToolKitSettings;

	pasteListener: (event: ClipboardEvent) => void;
	dropListener: () => void;

	// Workaround since the first version of the plugin had a single string for
	// the option
	getIgnoreFolders(): string[] {
		if (typeof this.settings.ignoreGlobalFolder === "string") {
			return [this.settings.ignoreGlobalFolder];
		}
		return this.settings.ignoreGlobalFolder ?? [];
	}
	parseDate(input: number | string): Date | undefined {
		if (typeof input === "string") {
			try {
				const parsedDate = parse(
					input,
					this.settings.dateFormat,
					new Date()
				);

				if (isNaN(parsedDate.getTime())) {
					return undefined;
				}

				return parsedDate;
			} catch (e) {
				console.error(e);
				return undefined;
			}
		}
		return new Date(input);
	}
	formatDate(input: Date): string | number {
		const output = format(input, this.settings.dateFormat);
		return output;
	}
	shouldUpdateValue(currentMtime: Date, updateHeader: Date): boolean {
		const nextUpdate = add(updateHeader, {
			minutes: this.settings.minMinutesBetweenSaves,
		});
		this.log(`${nextUpdate}`);
		this.log(`${currentMtime}`);
		return isAfter(currentMtime, nextUpdate);
	}
	async shouldFileBeIgnored(file: TFile): Promise<boolean> {
		if (!file.path) {
			return true;
		}
		if (file.extension != "md") {
			return true;
		}
		// Canvas files are created as 'Canvas.md',
		// so the plugin will update "frontmatter" and break the file when it gets created
		if (file.name == "Canvas.md") {
			return true;
		}

		const fileContent = (await this.app.vault.read(file)).trim();

		if (fileContent.length === 0) {
			return true;
		}

		const isExcalidrawFile = this.isExcalidrawFile(file);

		if (isExcalidrawFile) {
			return true;
		}
		const ignores = this.getIgnoreFolders();
		if (!ignores) {
			return false;
		}

		return ignores.some((ignoreItem) => file.path.startsWith(ignoreItem));
	}
	isExcalidrawFile(file: TFile): boolean {
		const ea: any =
			//@ts-expect-error this is comming from global context, injected by Excalidraw
			typeof ExcalidrawAutomate === "undefined"
				? undefined
				: //@ts-expect-error this is comming from global context, injected by Excalidraw
				  ExcalidrawAutomate; //ea will be undefined if the Excalidraw plugin is not running
		return ea ? ea.isExcalidrawFile(file) : false;
	}

	async handleFileChange(
		file: TAbstractFile
	): Promise<
		| { status: "ok" }
		| { status: "error"; error: any }
		| { status: "ignored" }
	> {
		if (!isTFile(file)) {
			return { status: "ignored" };
		}

		if (await this.shouldFileBeIgnored(file)) {
			return { status: "ignored" };
		}

		try {
			await this.app.fileManager.processFrontMatter(
				file,
				(frontmatter) => {
					const updatedKey = this.settings.headerUpdated;
					this.log("current metadata: ", frontmatter);
					this.log("current stat: ", file.stat);

					const mTime = this.parseDate(file.stat.mtime);

					if (!mTime) {
						return;
					}

					const currentMTimeOnFile = this.parseDate(
						frontmatter[updatedKey]
					);

					if (!frontmatter[updatedKey] || !currentMTimeOnFile) {
						frontmatter[updatedKey] = this.formatDate(mTime);
						this.log("No frontmatter");
						return;
					}

					if (this.shouldUpdateValue(mTime, currentMTimeOnFile)) {
						frontmatter[updatedKey] = this.formatDate(mTime);
						this.log("should update");
						return;
					}
				}
			);
		} catch (e: any) {
			if (e?.name === "YAMLParseError") {
				const errorMessage = `Update time on edit failed
	Malformed frontamtter on this file : ${file.path}
	
	${e.message}`;
				new Notice(errorMessage, 4000);
				console.error(errorMessage);
				return {
					status: "error",
					error: e,
				};
			}
		}
		return {
			status: "ok",
		};
	}
	getFiles() {
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		const currentMd = this.app.workspace.getActiveFile() as TFile;
		for (const [mdFile, links] of Object.entries(resolvedLinks)) {
			if (currentMd.path === mdFile) {
				return links;
			}
		}
		return null;
	}
	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "rename-all-image-url",
			name: "Rename All Image Url",
			editorCallback: (editor: Editor, view: MarkdownView) => {
				const cursor = editor.getCursor();
				const currentLine = cursor.line;
				const docContent = editor.getValue();
				const files = this.getFiles();
				if (files !== null) {
					const newContent = docContent.replace(
						/\!\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g,
						(_, url, alt) => {
							if (!alt) {
								alt = "";
							}
							let new_url = url;
							for (const [filePath, nr] of Object.entries(files)) {
								if (filePath.includes(url)) {
									new_url = filePath;
                  break;
								}
							}
							return `![${alt}](${new_url.replace(" ", "%20")})`;
						}
					);
					editor.setValue(newContent);
				}

				editor.setCursor({ line: currentLine, ch: 0 });
				// Ensure the current line is in a visible position
				editor.scrollIntoView({
					from: { line: currentLine, ch: 0 },
					to: { line: currentLine, ch: 0 },
				});
			},
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile === file) {
					return this.handleFileChange(file);
				}
			})
		);

		this.pasteListener = (event: ClipboardEvent) => {};

		this.dropListener = () => {};

		this.app.workspace.onLayoutReady(() => {
			document.addEventListener("paste", this.pasteListener);
			document.addEventListener("drop", this.dropListener);
		});
		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ToolkitSettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => console.log("setInterval"), 5 * 60 * 1000)
		);
	}
	onunload() {
		// Remove event listener for contextmenu event on image elements
		// Remove the event listeners when the plugin is unloaded
		document.removeEventListener("paste", this.pasteListener);
		document.removeEventListener("drop", this.dropListener);
	}
	log(...data: any[]) {
		return;
		console.log("[UTOE]:", ...data);
	}
	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class ToolkitSettingTab extends PluginSettingTab {
	plugin: ToolKitPlugin;

	constructor(app: App, plugin: ToolKitPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		this.addExcludedFoldersSetting();
		this.addTimeBetweenUpdates();
		this.addDateFormat();
		this.addFrontMatterUpdated();
	}

	addDateFormat(): void {
		this.createDateFormatEditor({
			getValue: () => this.plugin.settings.dateFormat,
			name: "Date format",
			description: "The date format for read and write",
			setValue: (newValue) =>
				(this.plugin.settings.dateFormat = newValue),
		});
	}

	createDateFormatEditor({
		description,
		name,
		getValue,
		setValue,
	}: DateFormatArgs) {
		const createDoc = () => {
			const descr = document.createDocumentFragment();
			descr.append(
				description,
				descr.createEl("br"),
				"Check ",
				descr.createEl("a", {
					href: "https://date-fns.org/v2.25.0/docs/format",
					text: "date-fns documentation",
				}),
				descr.createEl("br"),
				`Currently: ${format(new Date(), getValue())}`,
				descr.createEl("br"),
				`Obsidian default format for date properties: yyyy-MM-dd'T'HH:mm`
			);
			return descr;
		};
		let dformat = new Setting(this.containerEl)
			.setName(name)
			.setDesc(createDoc())
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.dateFormat)
					.setValue(getValue())
					.onChange(async (value) => {
						setValue(value);
						dformat.setDesc(createDoc());
						await this.plugin.saveSettings();
					})
			);
	}
	addTimeBetweenUpdates(): void {
		new Setting(this.containerEl)
			.setName("Minimum number of minutes between update")
			.setDesc("If your files are updating too often, increase this.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 30, 1)
					.setValue(this.plugin.settings.minMinutesBetweenSaves)
					.onChange(async (value) => {
						this.plugin.settings.minMinutesBetweenSaves = value;
						await this.plugin.saveSettings();
					})
					.setDynamicTooltip()
			);
	}
	addFrontMatterUpdated(): void {
		new Setting(this.containerEl)
			.setName("Front matter updated name")
			.setDesc("The key in the front matter yaml for the update time.")
			.addText((text) =>
				text
					.setPlaceholder("updated")
					.setValue(this.plugin.settings.headerUpdated ?? "")
					.onChange(async (value) => {
						this.plugin.settings.headerUpdated = value;
						await this.plugin.saveSettings();
					})
			);
	}
	addExcludedFoldersSetting(): void {
		this.doSearchAndRemoveList({
			currentList: this.plugin.getIgnoreFolders(),
			setValue: async (newValue) => {
				this.plugin.settings.ignoreGlobalFolder = newValue;
			},
			name: "Folder to exclude of all updates",
			description:
				"Any file updated in this folder will not trigger an updated and created update.",
		});
	}
	doSearchAndRemoveList({
		currentList,
		setValue,
		description,
		name,
	}: ArgsSearchAndRemove) {
		let searchInput: SearchComponent | undefined;
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(description)
			.addSearch((cb) => {
				searchInput = cb;
				cb.setPlaceholder("Example: folder1/folder2");
				// @ts-ignore
				cb.containerEl.addClass("time_search");
			})
			.addButton((cb) => {
				cb.setIcon("plus");
				cb.setTooltip("Add folder");
				cb.onClick(async () => {
					if (!searchInput) {
						return;
					}
					const newFolder = searchInput.getValue();

					await setValue([...currentList, newFolder]);
					await this.plugin.saveSettings();
					searchInput.setValue("");
					this.display();
				});
			});

		currentList.forEach((ignoreFolder) =>
			new Setting(this.containerEl)
				.setName(ignoreFolder)
				.addButton((button) =>
					button.setButtonText("Remove").onClick(async () => {
						await setValue(
							currentList.filter(
								(value) => value !== ignoreFolder
							)
						);
						await this.plugin.saveSettings();
						this.display();
					})
				)
		);
	}
}

type DateFormatArgs = {
	getValue: () => string;
	setValue: (newValue: string) => void;
	name: string;
	description: string;
};

type ArgsSearchAndRemove = {
	name: string;
	description: string;
	currentList: string[];
	setValue: (newValue: string[]) => Promise<void>;
};
