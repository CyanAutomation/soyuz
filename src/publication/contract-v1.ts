import { z } from "zod";
import { stableStringify } from "../lib/canonical-json";

export const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;
const BASE_REF = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)*$/;
const REPOSITORY_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,97}[a-z0-9])?$/;
const REPOSITORY_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

const RepositorySchema = z.object({
  owner: z.string().min(1).max(39).regex(REPOSITORY_OWNER),
  name: z.string().min(1).max(100).regex(REPOSITORY_NAME),
}).strict();

const ContentSchema = z.object({
  mediaType: z.literal("text/plain; charset=utf-8"),
  encoding: z.literal("base64"),
  byteLength: z.number().int().min(0).max(1_048_576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.string().max(1_398_104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
const FilePath = z.string().min(1).max(1_024).regex(/^[^/\\:]+(?:\/[^/\\:]+)*$/);
const FileChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add"), path: FilePath, content: ContentSchema }).strict(),
  z.object({ operation: z.literal("modify"), path: FilePath, baseBlobSha: z.string().regex(GIT_SHA), content: ContentSchema }).strict(),
  z.object({ operation: z.literal("delete"), path: FilePath, baseBlobSha: z.string().regex(GIT_SHA) }).strict(),
]);

const PublicationArtifactSchema = z.object({
  contractVersion: z.literal("1"),
  artifactId: z.string().regex(UUID7),
  runId: z.string().regex(UUID7),
  repository: RepositorySchema,
  baseRef: z.string().min(1).max(128).regex(BASE_REF),
  baseSha: z.string().regex(GIT_SHA),
  fileCount: z.number().int().min(1).max(100),
  totalBytes: z.number().int().min(0).max(5_242_880),
  files: z.array(FileChangeSchema).min(1).max(100),
}).strict();

export type PublicationArtifact = z.infer<typeof PublicationArtifactSchema>;
export type PublicationRequest = {
  contractVersion: "1";
  publicationId: string;
  runId: string;
  repository: { owner: string; name: string };
  mode: "branch" | "pr";
  baseRef: string;
  baseSha: string;
  headRef: string;
  title?: string;
  body?: string;
  artifact: PublicationArtifact;
  artifactDigest: string;
};

export function canonicalJson(value: unknown): string {
  assertCanonicalizable(value);
  return stableStringify(value);
}

function assertCanonicalizable(value: unknown): void {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0))) {
    throw new TypeError("Publication contract numbers must be safe integers");
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertCanonicalizable(entry);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) assertCanonicalizable(entry);
  }
}

export async function validatePublicationArtifact(input: unknown, expected: {
  runId: string;
  artifactId: string;
  repositoryUrl: string;
  baseRef: string;
}, expectedDigest?: string): Promise<{ artifact: PublicationArtifact; digest: string }> {
  const parsed = PublicationArtifactSchema.parse(input);
  const errors = validateArtifactMetadata(parsed, expected);
  const fileValidation = await validateArtifactFiles(parsed.files);
  errors.push(...fileValidation.errors);
  if (parsed.totalBytes !== fileValidation.totalBytes || fileValidation.totalBytes > 5_242_880) {
    errors.push("artifact byte count mismatch");
  }

  const canonical = canonicalJson(parsed);
  if (new TextEncoder().encode(canonical).byteLength > 8 * 1024 * 1024) errors.push("manifest too large");
  const digest = `sha256:${await digestHex(new TextEncoder().encode(canonical))}`;
  if (expectedDigest && expectedDigest !== digest) errors.push("artifact digest mismatch");
  if (errors.length) throw new PublicationContractError(errors);
  return { artifact: parsed, digest };
}

function validateArtifactMetadata(artifact: PublicationArtifact, expected: {
  runId: string;
  artifactId: string;
  repositoryUrl: string;
  baseRef: string;
}): string[] {
  const errors: string[] = [];
  if (artifact.runId !== expected.runId || artifact.artifactId !== expected.artifactId) errors.push("artifact identity mismatch");
  const destination = githubRepository(expected.repositoryUrl);
  if (!destination || artifact.repository.owner !== destination.owner || artifact.repository.name !== destination.name) {
    errors.push("repository mismatch");
  }
  if (artifact.baseRef !== expected.baseRef) errors.push("base branch mismatch");
  if (isUnsafeBaseRef(artifact.baseRef)) errors.push("unsafe base branch reference");
  if (artifact.fileCount !== artifact.files.length) errors.push("file count mismatch");
  return errors;
}

function isUnsafeBaseRef(baseRef: string): boolean {
  return baseRef.includes("..") || /\.lock(?:\/|$)/.test(baseRef) || baseRef.includes("@{");
}

type PublicationFileContent = Extract<PublicationArtifact["files"][number], { content: unknown }>["content"];

async function validateArtifactFiles(files: PublicationArtifact["files"]): Promise<{ errors: string[]; totalBytes: number }> {
  const errors: string[] = [];
  const foldedPaths: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const folded = file.path.toLowerCase().normalize("NFC");
    errors.push(...validateFilePath(file.path, folded));
    foldedPaths.push(folded);
    if ("content" in file) {
      const content = await validateFileContent(file.content);
      errors.push(...content.errors);
      totalBytes += content.byteLength;
    }
  }

  const unique = new Set(foldedPaths);
  if (unique.size !== foldedPaths.length) errors.push("duplicate case-folded file path");
  const sorted = [...files].sort((left, right) => compareUtf8(left.path, right.path));
  if (sorted.some((file, index) => file.path !== files[index]?.path)) errors.push("file list is not sorted");
  for (let index = 0; index < countParentPathConflicts(foldedPaths); index += 1) {
    errors.push("file path conflicts with a parent path");
  }
  return { errors, totalBytes };
}

function validateFilePath(path: string, folded: string): string[] {
  const errors: string[] = [];
  const unsafe = path.startsWith("/") || path.includes("\\") || path.includes(":") || path.normalize("NFC") !== path
    || /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}]/u.test(path)
    || path.split("/").some(isUnsafePathSegment);
  if (unsafe) errors.push("unsafe file path");
  if (folded === ".github/workflows" || folded.startsWith(".github/workflows/")) errors.push("workflow changes are unsupported");
  if (folded === ".gitattributes" || folded.endsWith("/.gitattributes")) errors.push("gitattributes changes are unsupported");
  return errors;
}

function isUnsafePathSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git"
    || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment);
}

function countParentPathConflicts(paths: string[]): number {
  const unique = new Set(paths);
  let conflicts = 0;
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (unique.has(segments.slice(0, index).join("/"))) conflicts += 1;
    }
  }
  return conflicts;
}

async function validateFileContent(content: PublicationFileContent): Promise<{ errors: string[]; byteLength: number }> {
  const errors: string[] = [];
  let byteLength = 0;
  try {
    const decoded = atob(content.data);
    if (btoa(decoded) !== content.data) errors.push("non-canonical base64 content");
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    byteLength = bytes.byteLength;
    if (byteLength !== content.byteLength || byteLength > 1_048_576) errors.push("content length mismatch");
    if (await digestHex(bytes) !== content.sha256) errors.push("content digest mismatch");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) errors.push("binary control byte in content");
    if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) errors.push("Git LFS content is unsupported");
  } catch {
    errors.push("invalid base64 or UTF-8 content");
  }
  return { errors, byteLength };
}

export function githubRepository(urlValue: string): { owner: string; name: string } | null {
  try {
    const url = new URL(urlValue);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || !match || url.username || url.password || url.search || url.hash) return null;
    const owner = match[1]!.toLowerCase();
    const name = match[2]!.replace(/\.git$/i, "").toLowerCase();
    if (!REPOSITORY_OWNER.test(owner) || !REPOSITORY_NAME.test(name)) return null;
    return { owner, name };
  } catch {
    return null;
  }
}

export async function digestHex(bytes: Uint8Array): Promise<string> {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

class PublicationContractError extends Error {
  constructor(readonly issues: string[]) {
    super("Publication manifest is invalid");
  }
}
