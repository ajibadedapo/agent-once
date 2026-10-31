import { describe, expect, test } from 'vitest';
import {
  DEFAULT_IRREVERSIBLE_PATTERNS,
  DEFAULT_MONEY_PATTERNS,
  DEFAULT_SIDE_EFFECT_PATTERNS,
  classifyTool,
  matchesAnyPattern,
} from '../src/guard/classify.js';

const defaults = { money: [...DEFAULT_MONEY_PATTERNS], irreversible: [...DEFAULT_IRREVERSIBLE_PATTERNS] };

describe('classifyTool', () => {
  test('the default pattern lists are the agreed words', () => {
    expect(DEFAULT_SIDE_EFFECT_PATTERNS).toEqual([
      'pay',
      'buy',
      'checkout',
      'book',
      'confirm',
      'submit',
      'send',
      'delete',
      'publish',
      'order',
      'purchase',
      'place',
      'create',
      'post',
    ]);
    expect(DEFAULT_MONEY_PATTERNS).toEqual(['pay', 'buy', 'checkout', 'purchase', 'charge', 'order', 'payment', 'transfer']);
    expect(DEFAULT_IRREVERSIBLE_PATTERNS).toEqual(['delete', 'publish', 'send', 'deploy']);
  });

  test('matches whole words in snake case, kebab case, camel case and description text', () => {
    expect(classifyTool('place_order', '', defaults)).toBe('money');
    expect(classifyTool('sendEmail', '', defaults)).toBe('irreversible');
    expect(classifyTool('blog-publish', '', defaults)).toBe('irreversible');
    expect(classifyTool('run', 'Transfer funds between accounts', defaults)).toBe('money');
    expect(classifyTool('PAY', '', defaults)).toBe('money');
  });

  test('does not match a pattern inside a longer word', () => {
    expect(classifyTool('display_payload', 'Shows the payroll summary', defaults)).toBe('standard');
    expect(classifyTool('get_orders', 'Lists the border crossings', defaults)).toBe('standard');
    expect(classifyTool('resend_preview', '', defaults)).toBe('standard');
  });

  test('money wins over irreversible', () => {
    expect(classifyTool('send_payment', '', defaults)).toBe('money');
    expect(classifyTool('delete_item', 'and charge the card', defaults)).toBe('money');
  });

  test('multi-word patterns match consecutive words', () => {
    expect(classifyTool('wire', 'Sends a wire transfer', { money: ['wire transfer'], irreversible: [] })).toBe('money');
    expect(classifyTool('wire', 'transfer by wire', { money: ['wire transfer'], irreversible: [] })).toBe('standard');
  });

  test('matchesAnyPattern finds side-effect tools by name or description', () => {
    expect(matchesAnyPattern('book_table', '', DEFAULT_SIDE_EFFECT_PATTERNS)).toBe(true);
    expect(matchesAnyPattern('lookup', 'Read the bookings list', DEFAULT_SIDE_EFFECT_PATTERNS)).toBe(false);
  });
});
