import { existsSync } from "node:fs";
import { mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const venv = path.join(root, ".venv", "pmtiles");
const python = path.join(venv, "bin", "python");
if (
  existsSync(process.env.PMTILES_PYTHON ?? "") ||
  existsSync("/opt/pmtiles/bin/python") ||
  existsSync(python)
)
  process.exit(0);
await mkdir(path.dirname(venv), { recursive: true });
const create = spawnSync("python3", ["-m", "venv", venv], { stdio: "inherit" });
if (create.status !== 0) process.exit(create.status ?? 1);
const install = spawnSync(
  python,
  [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "-r",
    path.join(root, "scripts", "requirements-pmtiles.txt"),
  ],
  { stdio: "inherit" },
);
if (install.status !== 0) process.exit(install.status ?? 1);
