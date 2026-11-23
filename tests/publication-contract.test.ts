import { describe, expect, it } from "vitest";
import requestFixture from "./fixtures/kirisame-publication-request-v1.json";
import resultFixture from "./fixtures/kirisame-successful-pr-result-v1.json";
import { canonicalJson, validatePublicationArtifact, type PublicationRequest } from "../src/publication/contract-v1";
import { buildPublicationRequest } from "../src/publication/lifecycle";
import { PublicationResultSchema } from "../src/publication/rpc-v1";

describe("Kirisame v1 compatibility fixtures", () => {
  it("reconstructs the canonical request fixture and validates its artifact digest", async () => {
    const request = requestFixture.value as PublicationRequest;
    const artifact = await validatePublicationArtifact(request.artifact, {
      runId: request.runId,
      artifactId: request.artifact.artifactId,
      repositoryUrl: `https://github.com/${request.repository.owner}/${request.repository.name}`,
      baseRef: request.baseRef,
    }, request.artifactDigest);
    expect(artifact.digest).toBe(request.artifactDigest);

    const reconstructed = buildPublicationRequest({
      publication_id: request.publicationId,
      run_id: request.runId,
      repository_owner: request.repository.owner,
      repository_name: request.repository.name,
      mode: request.mode,
      base_ref: request.baseRef,
      base_sha: request.baseSha,
      head_ref: request.headRef,
      title: request.title ?? null,
      body: request.body ?? null,
      artifact_digest: request.artifactDigest,
    }, artifact.artifact);
    expect(canonicalJson(reconstructed)).toBe(canonicalJson(request));
  });

  it("accepts the canonical open PR result fixture", () => {
    expect(PublicationResultSchema.parse(resultFixture.value)).toEqual(resultFixture.value);
  });

  it("rejects unsafe and case-colliding file paths", async () => {
    const request = requestFixture.value as PublicationRequest;
    const expected = {
      runId: request.runId,
      artifactId: request.artifact.artifactId,
      repositoryUrl: `https://github.com/${request.repository.owner}/${request.repository.name}`,
      baseRef: request.baseRef,
    };

    const traversal = structuredClone(request.artifact);
    traversal.files[0]!.path = "../private.txt";
    await expect(validatePublicationArtifact(traversal, expected)).rejects.toMatchObject({
      issues: expect.arrayContaining(["unsafe file path"]),
    });

    const collision = structuredClone(request.artifact);
    collision.files.push({ ...collision.files[0]!, path: collision.files[0]!.path.toLowerCase() });
    collision.fileCount = collision.files.length;
    collision.totalBytes *= 2;
    await expect(validatePublicationArtifact(collision, expected)).rejects.toMatchObject({
      issues: expect.arrayContaining(["duplicate case-folded file path"]),
    });
  });

  it("rejects workflow edits, provenance mismatches, and tampered file contents", async () => {
    const request = requestFixture.value as PublicationRequest;
    const expected = {
      runId: request.runId,
      artifactId: request.artifact.artifactId,
      repositoryUrl: `https://github.com/${request.repository.owner}/${request.repository.name}`,
      baseRef: request.baseRef,
    };

    const workflow = structuredClone(request.artifact);
    workflow.files[0]!.path = ".github/workflows/release.yml";
    await expect(validatePublicationArtifact(workflow, expected)).rejects.toMatchObject({
      issues: expect.arrayContaining(["workflow changes are unsupported"]),
    });

    const wrongRepository = structuredClone(request.artifact);
    wrongRepository.repository.name = "another-project";
    await expect(validatePublicationArtifact(wrongRepository, expected)).rejects.toMatchObject({
      issues: expect.arrayContaining(["repository mismatch"]),
    });

    const tampered = structuredClone(request.artifact);
    const tamperedFile = tampered.files[0]!;
    if (!("content" in tamperedFile)) throw new Error("The fixture must contain file content.");
    tamperedFile.content.data = btoa("tampered content");
    await expect(validatePublicationArtifact(tampered, expected)).rejects.toMatchObject({
      issues: expect.arrayContaining(["content length mismatch", "content digest mismatch"]),
    });
  });
});
