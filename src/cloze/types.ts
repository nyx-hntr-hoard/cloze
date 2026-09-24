/**
 * Cloze engine types.
 *
 * This module and its siblings are pure: no React, no Dexie, no DOM. They take
 * a string and return data. That is what makes the grammar testable on its own
 * and keeps the riskiest part of the app out of the UI's way.
 */

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

/** Literal text between cloze deletions. Escape sequences are already resolved. */
export interface TextNode {
  kind: 'text';
  /** Display text, with `\:` `\{` `\}` `\\` already unescaped. */
  text: string;
  /** Offsets into the original source, for editor highlighting. */
  start: number;
  end: number;
}

/** A single `{{cN::answer}}` or `{{cN::answer::hint}}`. */
export interface ClozeNode {
  kind: 'cloze';
  /** 1-based. Several nodes may share an ordinal; they blank together. */
  ordinal: number;
  /** The answer text, unescaped. May be empty (a warning is emitted). */
  answer: string;
  /** Shown in place of the blank when present. */
  hint?: string;
  start: number;
  end: number;
}

export type Node = TextNode | ClozeNode;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticCode =
  /** `{{cN::` with no matching `}}`. */
  | 'unclosed-cloze'
  /** A cloze inside another cloze. Anki rejects these and so do we. */
  | 'nested-cloze'
  /** `{{c0::...}}` — ordinals are 1-based. */
  | 'invalid-ordinal'
  /** `{{c1::}}` — a card that asks nothing. */
  | 'empty-answer'
  /** Text with no cloze markup at all generates no cards. */
  | 'no-cloze'
  /** Braces inside a cloze body don't balance, so its extent is ambiguous. */
  | 'unbalanced-braces'
  // --- note-level, for basic notes (see src/notetypes.ts) ---
  /** A basic note with nothing on the front. */
  | 'empty-front'
  /** A basic note with nothing on the back. */
  | 'empty-back'
  /** Cloze markup on a basic note, where it renders literally. */
  | 'cloze-in-basic';

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: DiagnosticCode;
  message: string;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Parse result
// ---------------------------------------------------------------------------

export interface ParseResult {
  nodes: Node[];
  diagnostics: Diagnostic[];
  /** Distinct ordinals present, ascending. One card is generated per entry. */
  ordinals: number[];
}

// ---------------------------------------------------------------------------
// Render segments
// ---------------------------------------------------------------------------

/** Plain text to display. */
export interface TextSegment {
  kind: 'text';
  text: string;
}

/** The deletion being tested, hidden. */
export interface BlankSegment {
  kind: 'blank';
  ordinal: number;
  /** Shown inside the blank when the author supplied one. */
  hint?: string;
}

/** The deletion being tested, revealed on the back of the card. */
export interface RevealSegment {
  kind: 'reveal';
  ordinal: number;
  text: string;
}

/**
 * Another deletion's answer, shown as ordinary context. On the card for `c1`,
 * the text of `c2` is simply part of the sentence.
 */
export interface ContextSegment {
  kind: 'context';
  ordinal: number;
  text: string;
}

/** An `![alt](media:<id>)` reference. */
export interface MediaSegment {
  kind: 'media';
  id: string;
  alt: string;
}

/**
 * A rule between question and answer. Used on the back of a basic card, where
 * everything below the line is the answer — Anki's layout, and the reason the
 * answer needs no highlight of its own.
 */
export interface DividerSegment {
  kind: 'divider';
}

export type Segment =
  | TextSegment
  | BlankSegment
  | RevealSegment
  | ContextSegment
  | MediaSegment
  | DividerSegment;

export interface RenderedCard {
  ordinal: number;
  /** What the reviewer sees before answering. */
  front: Segment[];
  /** What they see after. Identical to `front` except the target is revealed. */
  back: Segment[];
}
