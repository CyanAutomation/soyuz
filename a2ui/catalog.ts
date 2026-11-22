import { Catalog } from "@a2ui/web_core/catalog";
import basicCatalogDocument from "./basic-catalog-v1.json";

export const A2UI_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

/** Schema-only catalog: the full official entry point also imports browser-only Lit components. */
export const basicCatalog = Catalog.fromJson(
  basicCatalogDocument as Record<string, any>,
  "1.0",
  A2UI_CATALOG_ID,
);
