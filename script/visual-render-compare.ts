import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

type Editor = {
  handleInput(data: string): void;
  render(width: number): string[];
  setClipboardFn(fn: (text: string, signal?: AbortSignal) => unknown): void;
};

type EditorCtor = new (
  tui: unknown,
  theme: unknown,
  keybindings: unknown,
) => Editor;

type Metric = {
  medianUs: number;
  samples: number[];
};

const repoRoot = process.cwd();
const entryPath = process.env.PIVIM_ENTRY
  ? path.resolve(process.env.PIVIM_ENTRY)
  : path.resolve(repoRoot, "index.ts");
const { ModalEditor } = (await import(pathToFileURL(entryPath).href)) as {
  ModalEditor: EditorCtor;
};

const stubTui = {
  requestRender() {},
  terminal: { rows: 40, cols: 120 },
};
const stubTheme = {
  borderColor: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
};
const stubKeybindings = { matches: () => false };

function createEditor(text: string, mode: "v" | "V", moves: string[]): Editor {
  const editor = new ModalEditor(stubTui, stubTheme, stubKeybindings);
  editor.setClipboardFn(() => {});
  editor.handleInput(text);
  editor.handleInput("\x1b");
  editor.handleInput("0");
  editor.handleInput(mode);
  for (const key of moves) editor.handleInput(key);
  return editor;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(
  create: () => Editor,
  width: number,
  iterations = 2_000,
  sampleCount = 9,
): Metric {
  const samples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    const editor = create();
    for (let warmup = 0; warmup < 100; warmup++) editor.render(width);

    const started = performance.now();
    for (let iteration = 0; iteration < iterations; iteration++) {
      editor.render(width);
    }
    samples.push(((performance.now() - started) * 1_000) / iterations);
  }
  return { medianUs: median(samples), samples };
}

const fixtures: Record<string, [() => Editor, number]> = {
  long_ascii_80: [
    () => createEditor("alpha beta gamma delta ".repeat(10), "v", ["$"]),
    80,
  ],
  long_zwj_80: [() => createEditor("a👩‍💻bc ".repeat(40), "v", ["$"]), 80],
  multiline_ansi_80: [
    () =>
      createEditor(
        Array.from(
          { length: 20 },
          (_, index) => `line ${index} alpha beta`,
        ).join("\n"),
        "V",
        ["9", "j"],
      ),
    80,
  ],
  wrapped_ascii_32: [
    () => createEditor("alpha beta gamma delta ".repeat(10), "v", ["$"]),
    32,
  ],
};

const metrics: Record<string, Metric> = {};
for (const [name, [create, width]] of Object.entries(fixtures)) {
  metrics[name] = measure(create, width);
}

process.stdout.write(
  `${JSON.stringify({ entry: entryPath, nodeVersion: process.version, metrics }, null, 2)}\n`,
);
