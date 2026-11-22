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

export const PublicationArtifactSchema = z.object({
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
  const errors: string[] = [];
  if (parsed.runId !== expected.runId || parsed.artifactId !== expected.artifactId) errors.push("artifact identity mismatch");
  const destination = githubRepository(expected.repositoryUrl);
  if (!destination || parsed.repository.owner !== destination.owner || parsed.repository.name !== destination.name) errors.push("repository mismatch");
  if (parsed.baseRef !== expected.baseRef) errors.push("base branch mismatch");
  if (parsed.baseRef.includes("..") || /\.lock(?:\/|$)/.test(parsed.baseRef) || parsed.baseRef.includes("@{")) {
    errors.push("unsafe base branch reference");
  }
  if (parsed.fileCount !== parsed.files.length) errors.push("file count mismatch");

  let totalBytes = 0;
  const paths: string[] = [];
  for (const file of parsed.files) {
    const path = file.path;
    const folded = path.toLowerCase().normalize("NFC");
    const segments = path.split("/");
    if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.normalize("NFC") !== path
      || /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}]/u.test(path)
      || segments.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git" || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) errors.push("unsafe file path");
    if (folded === ".github/workflows" || folded.startsWith(".github/workflows/")) errors.push("workflow changes are unsupported");
    if (folded === ".gitattributes" || folded.endsWith("/.gitattributes")) errors.push("gitattributes changes are unsupported");
    paths.push(folded);
    if ("content" in file) {
      try {
        const decoded = atob(file.content.data);
        if (btoa(decoded) !== file.content.data) errors.push("non-canonical base64 content");
        const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
        if (bytes.byteLength !== file.content.byteLength || bytes.byteLength > 1_048_576) errors.push("content length mismatch");
        totalBytes += bytes.byteLength;
        const digest = await digestHex(bytes);
        if (digest !== file.content.sha256) errors.push("content digest mismatch");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) errors.push("binary control byte in content");
        if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) errors.push("Git LFS content is unsupported");
      } catch {
        errors.push("invalid base64 or UTF-8 content");
      }
    }
  }
  if (parsed.totalBytes !== totalBytes || totalBytes > 5_242_880) errors.push("artifact byte count mismatch");
  const unique = new Set(paths);
  if (unique.size !== paths.length) errors.push("duplicate case-folded file path");
  const sorted = [...parsed.files].sort((a, b) => compareUtf8(a.path, b.path));
  if (sorted.some((file, index) => file.path !== parsed.files[index]?.path)) errors.push("file list is not sorted");
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (unique.has(parts.slice(0, index).join("/"))) errors.push("file path conflicts with a parent path");
    }
  }

  const canonical = canonicalJson(parsed);
  if (new TextEncoder().encode(canonical).byteLength > 8 * 1024 * 1024) errors.push("manifest too large");
  const digest = `sha256:${await digestHex(new TextEncoder().encode(canonical))}`;
  if (expectedDigest && expectedDigest !== digest) errors.push("artifact digest mismatch");
  if (errors.length) throw new PublicationContractError(errors);
  return { artifact: parsed, digest };
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

export class PublicationContractError extends Error {
  constructor(readonly issues: string[]) {
    super("Publication manifest is invalid");
  }
}
