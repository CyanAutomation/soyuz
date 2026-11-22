import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS_DIRECTORY = path.join(".github", "skills");
const REPOSITORY_DIRECTORIES = [
  ".agents",
  ".github",
  "dashboard",
  "docs",
  "migrations",
  "openui",
  "public",
  "scripts",
  "src",
  "tests",
];
const ROOT_FILES = new Set(["README.md", "package.json", "wrangler.jsonc"]);
const PATH_DELIMITERS = /[\s,;:!?()[\]{}"'<>]+/;

function isRepositoryPath(value) {
  return (
    ROOT_FILES.has(value) ||
    REPOSITORY_DIRECTORIES.some((directory) => value.startsWith(`${directory}/`))
  );
}

export function collectSkillPathReferences(markdown) {
  const references = [];
  const inlineCode = /`([^`]+)`/g;

  for (const match of markdown.matchAll(inlineCode)) {
    const line = markdown.slice(0, match.index).split("\n").length;
    for (const rawToken of match[1].split(PATH_DELIMITERS)) {
      const candidate = rawToken
        .replace(/^\.\//, "")
        .replace(/#.*$/, "")
        .replace(/[.,]+$/, "");
      if (candidate && isRepositoryPath(candidate)) {
        references.push({ path: candidate, line });
      }
    }
  }

  return references;
}

function markdownFiles(directory, root) {
  if (!existsSync(directory)) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...markdownFiles(absolutePath, root));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path.relative(root, absolutePath).split(path.sep).join("/"));
    }
  }
  return files.sort();
}

export function validateSkillReferences(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const skillsDirectory = path.join(root, SKILLS_DIRECTORY);
  const files = markdownFiles(skillsDirectory, root);
  const problems = [];
  let referenceCount = 0;

  if (files.length === 0) {
    problems.push({
      file: SKILLS_DIRECTORY,
      line: 0,
      path: SKILLS_DIRECTORY,
      reason: "no skill Markdown files found",
    });
  }

  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const reference of collectSkillPathReferences(source)) {
      referenceCount += 1;
      const resolved = path.resolve(root, reference.path);
      const relative = path.relative(root, resolved);
      const outsideRepository =
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative);

      if (outsideRepository) {
        problems.push({ ...reference, file, reason: "outside repository" });
      } else if (!existsSync(resolved)) {
        problems.push({ ...reference, file, reason: "missing" });
      }
    }
  }

  return { skillFiles: files.length, references: referenceCount, problems };
}

function main() {
  const result = validateSkillReferences(process.cwd());
  if (result.problems.length > 0) {
    for (const problem of result.problems) {
      console.error(
        `${problem.file}:${problem.line}: ${problem.reason} repository path ${JSON.stringify(problem.path)}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Validated ${result.references} repository path references across ${result.skillFiles} skill Markdown files.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
