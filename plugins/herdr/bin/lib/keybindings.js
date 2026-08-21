'use strict';

// Herdr's plugin manifest cannot declare keybindings — `[[keys.command]]` is
// user config, so every plugin either documents a snippet and hopes, or writes
// it for the user. This module is the write side: pure functions over the
// config text, shared by install-keybindings.js, remove-keybindings.js, and
// Quick Start's "which key is this bound to" row.

const COMMAND_PREFIX = 'ccxray.herdr.';
const SECTION_MARKER = '# ccxray keybindings (managed by the ccxray Herdr plugin)';

// prefix+m / prefix+shift+m are free in Herdr 0.8.0's built-in keymap. Herdr
// exposes no way to enumerate its defaults, so a future release could claim
// either; the env overrides exist so a collision is a one-line fix and not a
// reinstall. Two keys is the ceiling other plugins observe (plugin-manager
// takes one, herdr-insight and herdr-plus take two) — grabbing more of a
// shared namespace for one plugin is the antisocial choice.
function defaultBindings(env = process.env) {
  return [
    {
      key: env.CCXRAY_HERDR_KEY_MISSION || 'prefix+m',
      command: `${COMMAND_PREFIX}mission-control`,
      description: 'ccxray: Mission Control',
    },
    {
      key: env.CCXRAY_HERDR_KEY_QUICK_START || 'prefix+shift+m',
      command: `${COMMAND_PREFIX}quick-start`,
      description: 'ccxray: Quick Start',
    },
  ];
}

const TABLE_START_RE = /^\[/;
// A trailing comment is legal TOML on a table header, and a hand-maintained
// config has them. Anchoring on end-of-line meant `[[keys.command]] # mine`
// matched TABLE_START_RE (so it closed the previous block) without matching
// here (so it opened none) — the block's key/command were skipped entirely, the
// installer concluded the binding was absent, and appended a duplicate that
// collides with the user's own.
const KEYS_COMMAND_HEADER_RE = /^\[\[keys\.command\]\][ \t]*(?:#.*)?$/;

function stringField(body, name) {
  const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*"([^"]*)"`, 'm').exec(body);
  return match ? match[1] : null;
}

// Splits the config into [[keys.command]] blocks. A block runs from its header
// line to the line before the next table header at column 0 — TOML requires
// table headers to be unindented, so nothing inside a block can be mistaken
// for the next one.
function parseKeyCommandBlocks(config) {
  const lines = String(config).split('\n');
  const blocks = [];
  let open = null;
  const close = end => {
    if (!open) return;
    const body = lines.slice(open.startLine, end).join('\n');
    blocks.push({
      startLine: open.startLine,
      endLine: end,
      key: stringField(body, 'key'),
      command: stringField(body, 'command'),
    });
    open = null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (KEYS_COMMAND_HEADER_RE.test(line)) {
      close(i);
      open = { startLine: i };
      continue;
    }
    if (open && TABLE_START_RE.test(line)) close(i);
  }
  close(lines.length);
  return blocks;
}

function renderBinding(binding) {
  return [
    '[[keys.command]]',
    `key = "${binding.key}"`,
    'type = "plugin_action"',
    `command = "${binding.command}"`,
    `description = "${binding.description}"`,
  ].join('\n');
}

// Returns { config, added, conflicts, unchanged }. A key the user already
// bound to something else is reported, never overwritten: silently stealing a
// keypress the user chose is worse than not installing.
function addBindings(config, bindings) {
  const text = String(config);
  const blocks = parseKeyCommandBlocks(text);
  const byKey = new Map(blocks.filter(b => b.key).map(b => [b.key, b]));
  const byCommand = new Map(blocks.filter(b => b.command).map(b => [b.command, b]));

  const added = [];
  const conflicts = [];
  for (const binding of bindings) {
    const existing = byKey.get(binding.key);
    if (existing) {
      if (existing.command !== binding.command) conflicts.push({ binding, boundTo: existing.command });
      continue;
    }
    // Already bound to a different key of the user's choosing: leave it alone.
    if (byCommand.has(binding.command)) continue;
    added.push(binding);
  }

  if (!added.length) return { config: text, added, conflicts, unchanged: true };

  const section = `${SECTION_MARKER}\n${added.map(renderBinding).join('\n\n')}\n`;
  const base = text.replace(/\s*$/, '');
  const next = base ? `${base}\n\n${section}` : section;
  return { config: next, added, conflicts, unchanged: false };
}

// Removes only blocks whose command belongs to this plugin, plus a marker
// comment left with no block under it. A binding the user re-pointed at their
// own command keeps its block.
function removeBindings(config) {
  const text = String(config);
  const lines = text.split('\n');
  const drop = new Set();
  for (const block of parseKeyCommandBlocks(text)) {
    if (!block.command || !block.command.startsWith(COMMAND_PREFIX)) continue;
    for (let i = block.startLine; i < block.endLine; i += 1) drop.add(i);
    // Take the marker comment directly above the first block with it.
    let above = block.startLine - 1;
    while (above >= 0 && lines[above].trim() === '') above -= 1;
    if (above >= 0 && lines[above].trim() === SECTION_MARKER) drop.add(above);
  }
  if (!drop.size) return { config: text, removed: 0 };

  const kept = lines.filter((_, i) => !drop.has(i));
  const next = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
  return { config: next === '\n' ? '' : next, removed: drop.size };
}

// What Quick Start renders next to a row: the key the user actually has bound,
// or null. Reads the config rather than assuming the default took effect.
function boundKeyFor(config, command) {
  const block = parseKeyCommandBlocks(config).find(b => b.command === command);
  return block ? block.key : null;
}

module.exports = {
  COMMAND_PREFIX,
  SECTION_MARKER,
  addBindings,
  boundKeyFor,
  defaultBindings,
  parseKeyCommandBlocks,
  removeBindings,
  renderBinding,
};
