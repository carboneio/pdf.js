
class GlobalDocumentBody {
  static #node = document.body; // by default, but can be overwritten when used in a shadow DOM

  static get node() {
    return this.#node;
  }

  static set node(val) {
    this.#node = val;
  }
}

export { GlobalDocumentBody };
