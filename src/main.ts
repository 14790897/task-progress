import { Plugin, TFile, CachedMetadata } from "obsidian";

const SVGNS = "http://www.w3.org/2000/svg";

// Only these count as done. Anything else (" ", "/", "-", ">", ...) is open.
const DONE_CHARS = new Set(["x", "X"]);

const SIZE = 14;
const CX = 7;
const CY = 7;
const R = 6;

interface Progress {
	total: number;
	done: number;
}

function svgEl(name: string, attrs: Record<string, string | number>): SVGElement {
	const el = document.createElementNS(SVGNS, name) as SVGElement;
	for (const key in attrs) el.setAttribute(key, String(attrs[key]));
	return el;
}

function wedgePath(cx: number, cy: number, r: number, a0: number, a1: number): string {
	const px = (a: number) => cx + r * Math.cos(a);
	const py = (a: number) => cy + r * Math.sin(a);
	const large = a1 - a0 > Math.PI ? 1 : 0;
	return (
		`M ${cx} ${cy}` +
		` L ${px(a0).toFixed(2)} ${py(a0).toFixed(2)}` +
		` A ${r} ${r} 0 ${large} 1 ${px(a1).toFixed(2)} ${py(a1).toFixed(2)} Z`
	);
}

function buildSvg(done: number, total: number): SVGElement {
	const svg = svgEl("svg", {
		viewBox: `0 0 ${SIZE} ${SIZE}`,
		width: SIZE,
		height: SIZE,
		class: "task-progress-svg",
		"aria-hidden": "true",
	});

	svg.appendChild(
		svgEl("circle", {
			cx: CX,
			cy: CY,
			r: R,
			fill: "none",
			stroke: "currentColor",
			"stroke-width": 1.2,
			opacity: 0.3,
		})
	);

	if (done <= 0) return svg;

	// A single task gets a filled dot; several tasks get wedges laid out
	// clockwise from 12 o'clock.
	if (total <= 1) {
		svg.appendChild(svgEl("circle", { cx: CX, cy: CY, r: R - 1, fill: "currentColor" }));
		return svg;
	}

	const step = (Math.PI * 2) / total;
	const gap = Math.min(step * 0.12, 0.1);
	const drawn = Math.min(done, total);
	for (let i = 0; i < drawn; i++) {
		const a0 = -Math.PI / 2 + i * step + gap / 2;
		const a1 = -Math.PI / 2 + (i + 1) * step - gap / 2;
		svg.appendChild(svgEl("path", { d: wedgePath(CX, CY, R - 1, a0, a1), fill: "currentColor" }));
	}
	return svg;
}

export default class TaskProgressPlugin extends Plugin {
	private timer: number | null = null;
	private observer: MutationObserver | null = null;

	async onload(): Promise<void> {
		this.app.workspace.onLayoutReady(() => this.start());
	}

	onunload(): void {
		if (this.observer) this.observer.disconnect();
		if (this.timer !== null) window.clearTimeout(this.timer);
		document.querySelectorAll(".task-progress-badge").forEach((el) => el.remove());
	}

	private start(): void {
		const root = document.querySelector(".nav-files-container");
		if (root) {
			this.observer = new MutationObserver(() => this.schedule());
			this.observer.observe(root, { childList: true, subtree: true });
			this.register(() => this.observer?.disconnect());
		}

		this.registerEvent(this.app.metadataCache.on("changed", () => this.schedule()));
		this.registerEvent(this.app.metadataCache.on("resolved", () => this.schedule()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.schedule()));
		this.registerEvent(this.app.vault.on("rename", () => this.schedule()));
		this.registerEvent(this.app.vault.on("delete", () => this.schedule()));

		this.schedule();
	}

	private schedule(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			try {
				this.refresh();
			} catch (e) {
				console.error("task-progress: refresh failed", e);
			}
		}, 120);
	}

	private refresh(): void {
		document.querySelectorAll<HTMLElement>(".nav-file-title[data-path]").forEach((node) => {
			const path = node.getAttribute("data-path");
			const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
			const progress = file instanceof TFile ? this.progressFor(file) : null;
			const existing = node.querySelector<HTMLElement>(":scope > .task-progress-badge");

			if (!progress) {
				existing?.remove();
				return;
			}

			// Leave the DOM alone when nothing changed, otherwise the
			// MutationObserver wakes itself up in a loop.
			if (
				existing &&
				existing.dataset.done === String(progress.done) &&
				existing.dataset.total === String(progress.total)
			) {
				return;
			}

			const badge = existing ?? document.createElement("span");
			if (!existing) {
				badge.className = "task-progress-badge";
				node.prepend(badge);
			}
			badge.dataset.done = String(progress.done);
			badge.dataset.total = String(progress.total);
			badge.setAttribute("data-complete", progress.done >= progress.total ? "true" : "false");
			badge.title = `${progress.done}/${progress.total} done`;
			badge.replaceChildren(buildSvg(progress.done, progress.total));
		});
	}

	private progressFor(file: TFile): Progress | null {
		if (file.extension !== "md") return null;

		const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;

		const tasks = (cache.listItems ?? []).filter((li) => li.task !== undefined);
		if (tasks.length > 0) {
			return {
				total: tasks.length,
				done: tasks.filter((li) => DONE_CHARS.has(li.task as string)).length,
			};
		}

		// No inline checkboxes: fall back to the note itself being a to-do,
		// which is what the bundled "new todo" template writes.
		const frontmatter = cache.frontmatter;
		if (frontmatter && frontmatter.todo === true) {
			return { total: 1, done: frontmatter.completed === true ? 1 : 0 };
		}

		return null;
	}
}
