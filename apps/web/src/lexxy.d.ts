// Lexxy ships no types. These are the parts of @37signals/lexxy 0.9.24 that rich-text-editor.tsx uses.
declare module "@37signals/lexxy" {
  /** Settings for every editor (`global`) and for each preset of them (`default`). */
  export function configure(settings: { global?: Record<string, unknown>; default?: Record<string, unknown> }): void;

  /** The parts of Lexical's LexicalNode that the composer uses. */
  export class LexicalNode {
    getType(): string;
    getParent(): ElementNode | null;
    getIndexWithinParent(): number;
    getNextSiblings(): LexicalNode[];
    getPreviousSibling(): LexicalNode | null;
    getTextContent(): string;
    insertAfter(node: LexicalNode): LexicalNode;
    remove(): void;
  }

  /** The parts of Lexical's ElementNode that Campfire's node and the composer use. */
  export class ElementNode extends LexicalNode {
    constructor(key?: string);
    readonly __key: string;
    exportJSON(): Record<string, unknown>;
    updateFromJSON(serialized: Record<string, unknown>): this;
    getChildren(): LexicalNode[];
    getChildrenSize(): number;
    append(...nodes: LexicalNode[]): this;
    select(anchorOffset?: number, focusOffset?: number): unknown;
  }

  /** Lexical's ParagraphNode. */
  export class ParagraphNode extends ElementNode {}

  /** The parts of Lexical's TextNode that the composer uses. */
  export class TextNode extends LexicalNode {
    select(anchorOffset?: number, focusOffset?: number): unknown;
    setTextContent(text: string): this;
  }

  /** A place in the editor: in a text node, at an offset, or in an element, before its child at an offset. */
  interface Point {
    type: "text" | "element";
    offset: number;
    getNode(): LexicalNode;
  }

  /** The parts of Lexical's RangeSelection that the composer uses. */
  interface RangeSelection {
    anchor: Point;
    isCollapsed(): boolean;
    setFormat(format: number): void;
    setStyle(style: string): void;
  }

  /** A command an editor carries out, as a key that it hears. */
  interface LexicalCommand<Payload> {
    readonly type?: string;
    readonly __payload?: Payload;
  }

  /** The parts of Lexical's LexicalEditor that the composer uses. */
  export interface LexicalEditor {
    registerCommand<Payload>(command: LexicalCommand<Payload>, listener: (payload: Payload) => boolean, priority: number): () => void;
    /** Lexxy's commands go by name, as its toolbar's buttons send them. */
    dispatchCommand(command: string, payload: undefined): boolean;
  }

  /** The Lexical Lexxy is built on, whose nodes an extension's must extend. */
  export const Lexical: {
    ElementNode: typeof ElementNode;
    $getSelection(): unknown;
    $isRangeSelection(selection: unknown): selection is RangeSelection;
    $copyNode<Node extends LexicalNode>(node: Node): Node;
    $createParagraphNode(): ParagraphNode;
    $isLineBreakNode(node: LexicalNode | null | undefined): node is LexicalNode;
    $isParagraphNode(node: LexicalNode | null | undefined): node is ParagraphNode;
    $isTextNode(node: LexicalNode | null | undefined): node is TextNode;
    COMMAND_PRIORITY_HIGH: number;
    KEY_BACKSPACE_COMMAND: LexicalCommand<KeyboardEvent | null>;
    KEY_SPACE_COMMAND: LexicalCommand<KeyboardEvent>;
  };

  /** What an editor allows and holds beyond Lexxy's own. */
  export class Extension {
    constructor(editorElement: HTMLElement);
    get allowedElements(): Array<string | { tag: string; attributes: string[] }>;
    get lexicalExtension(): unknown;
    defineExtension(extension: { name: string; nodes: unknown[]; register?: (editor: LexicalEditor) => () => void }): unknown;
  }
}
