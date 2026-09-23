import type { discoverModels } from "../model-catalog.js";
import type { ModelCatalog, ModelProvider } from "../../shared/protocol.js";

/**
 * Each provider's model catalog, as it last reported it.
 *
 * The model pickers read a catalog, and the chat's model is chosen from the
 * one they last read (D-102), so a planning's chat starts on what the person
 * was just offered rather than on a second reading of its own.
 */
export class ModelCatalogs {
  private readonly discover: typeof discoverModels;
  private readonly last = new Map<ModelProvider, ModelCatalog>();

  constructor(discover: typeof discoverModels) {
    this.discover = discover;
  }

  /** `provider`'s catalog, read now and kept. */
  async read(provider: ModelProvider): Promise<ModelCatalog> {
    const catalog = await this.discover(provider);
    this.last.set(provider, catalog);
    return catalog;
  }

  /**
   * The catalog last read, or else read here once and kept. A catalog that
   * cannot be read offers nothing.
   */
  async known(provider: ModelProvider): Promise<ModelCatalog | undefined> {
    return this.last.get(provider) ?? (await this.read(provider).catch(() => undefined));
  }
}
