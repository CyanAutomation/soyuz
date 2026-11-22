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
});
