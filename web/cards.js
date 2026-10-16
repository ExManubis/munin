// The option cards questions offer, in agent conversations and the tracker's inbox: a key,
// a label, a line of detail, and a filled check on the one picked.

import { h, svg } from './ui.js';

export const check = () => svg(14, '0 0 14 14', [['rect', { x: 0, y: 0, width: 14, height: 14, fill: '#EDEDED' }],
  ['path', { d: 'M3.5 7.5 L6 10 L10.5 4.5', fill: 'none', stroke: '#0A0A0A', 'stroke-width': 1.6 }]], { cls: 'check' });

// An answered card is solid and can't be picked again.
export function optionRow(index, option, { selected = false, answered = false, onclick } = {}) {
  return h(answered ? 'div' : 'button', {
    type: answered ? null : 'button',
    class: ['option-card', selected && 'selected', answered && 'answered'],
    onclick,
    'aria-pressed': answered ? null : String(selected),
  },
  h('span', { class: 'key-square' }, index + 1),
  h('span', { class: 'option-main' },
    h('span', { class: 'option-label' }, option.label),
    option.detail ? h('span', { class: 'option-detail' }, option.detail) : null),
  selected || answered ? check() : null);
}
