import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

const CONFIG_DIR = join(homedir(), ".config", "open-harness");
const PLANS_DIR = join(CONFIG_DIR, "plans");

// Word lists for generating random plan names
const ADJECTIVES = [
  "giggling",
  "dancing",
  "sleeping",
  "running",
  "jumping",
  "singing",
  "floating",
  "spinning",
  "glowing",
  "buzzing",
  "flying",
  "crawling",
  "bouncing",
  "whistling",
  "humming",
  "drifting",
  "twirling",
  "shimmering",
  "sparkling",
  "flickering",
  "swaying",
  "tumbling",
  "soaring",
  "prancing",
  "skipping",
];

const ANIMALS = [
  "lark",
  "panda",
  "otter",
  "fox",
  "owl",
  "tiger",
  "dolphin",
  "koala",
  "penguin",
  "rabbit",
  "eagle",
  "salmon",
  "turtle",
  "zebra",
  "falcon",
  "badger",
  "heron",
  "lynx",
  "crane",
  "finch",
  "lemur",
  "marmot",
  "osprey",
  "wombat",
  "quail",
];

const COLORS = [
  "crimson",
  "azure",
  "golden",
  "silver",
  "coral",
  "violet",
  "emerald",
  "amber",
  "ivory",
  "jade",
  "scarlet",
  "cobalt",
  "copper",
  "indigo",
  "bronze",
  "teal",
  "sage",
  "rust",
  "plum",
  "slate",
];

function randomElement<T>(array: T[]): T {
  const index = Math.floor(Math.random() * array.length);
  return array[index]!;
}

export function generatePlanName(): string {
  const adjective = randomElement(ADJECTIVES);
  const color = randomElement(COLORS);
  const animal = randomElement(ANIMALS);
  return `${adjective}-${color}-${animal}`;
}

export async function ensurePlansDir(): Promise<void> {
  await mkdir(PLANS_DIR, { recursive: true });
}

export function getPlanFilePath(planName: string): string {
  return join(PLANS_DIR, `${planName}.md`);
}

export function getPlansDir(): string {
  return PLANS_DIR;
}
