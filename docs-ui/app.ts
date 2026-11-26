import { isOpenApiDocument } from "./openapi-types.js";
import { renderOpenApiDocument } from "./render.js";

const status = document.getElementById("api-status");

void loadApiReference();

async function loadApiReference(): Promise<void> {
  if (!status) return;
  try {
    const response = await fetch("/openapi.json", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`OpenAPI request failed (${response.status})`);
    const documentValue: unknown = await response.json();
    if (!isOpenApiDocument(documentValue)) throw new Error("The OpenAPI document is incomplete.");
    renderOpenApiDocument(documentValue, document, window.location.origin);
  } catch {
    status.setAttribute("role", "alert");
    status.textContent = "The API reference could not be loaded. You can open the OpenAPI JSON file directly and try again later.";
  }
}
