import { describe, expect, test } from 'vitest';
import { ManualClock } from '../src/time/clock.js';

const START = 1_761_912_345_678;

describe('ManualClock', () => {
  test('nowMs starts at the given time and moves only on advance', () => {
    const clock = new ManualClock(START);
    expect(clock.nowMs()).toBe(START);
    clock.advance(250);
    expect(clock.nowMs()).toBe(START + 250);
  });

  test('ManualClock fires timers in order on advance and never early', () => {
    const clock = new ManualClock(START);
    const fired: Array<[string, number]> = [];
    clock.setTimer(300, () => fired.push(['c', clock.nowMs()]));
    clock.setTimer(100, () => fired.push(['a', clock.nowMs()]));
    clock.setTimer(200, () => fired.push(['b1', clock.nowMs()]));
    clock.setTimer(200, () => fired.push(['b2', clock.nowMs()]));
    clock.advance(99);
    expect(fired).toEqual([]);
    clock.advance(150);
    expect(fired).toEqual([
      ['a', START + 100],
      ['b1', START + 200],
      ['b2', START + 200],
    ]);
    expect(clock.nowMs()).toBe(START + 249);
    clock.advance(51);
    expect(fired.at(-1)).toEqual(['c', START + 300]);
    clock.advance(10_000);
    expect(fired).toHaveLength(4);
  });

  test('ManualClock runs a timer scheduled by another timer within the same advance', () => {
    const clock = new ManualClock(START);
    const fired: Array<[string, number]> = [];
    clock.setTimer(100, () => {
      fired.push(['outer', clock.nowMs()]);
      clock.setTimer(50, () => fired.push(['inner', clock.nowMs()]));
      clock.setTimer(500, () => fired.push(['late', clock.nowMs()]));
    });
    clock.setTimer(120, () => fired.push(['middle', clock.nowMs()]));
    clock.advance(200);
    expect(fired).toEqual([
      ['outer', START + 100],
      ['middle', START + 120],
      ['inner', START + 150],
    ]);
    expect(clock.nowMs()).toBe(START + 200);
  });

  test('a cancelled timer never fires', () => {
    const clock = new ManualClock(START);
    let fired = false;
    const timer = clock.setTimer(10, () => {
      fired = true;
    });
    timer.cancel();
    clock.advance(100);
    expect(fired).toBe(false);
  });

  test('a zero delay timer fires on advance(0), not when scheduled', () => {
    const clock = new ManualClock(START);
    let fired = false;
    clock.setTimer(0, () => {
      fired = true;
    });
    expect(fired).toBe(false);
    clock.advance(0);
    expect(fired).toBe(true);
  });

  test('a throwing timer still leaves the clock at the advance target and later timers pending', () => {
    const clock = new ManualClock(START);
    let laterFired = false;
    clock.setTimer(100, () => {
      throw new Error('boom');
    });
    clock.setTimer(150, () => {
      laterFired = true;
    });
    expect(() => clock.advance(200)).toThrow('boom');
    expect(clock.nowMs()).toBe(START + 200);
    expect(laterFired).toBe(false);
    clock.advance(0);
    expect(laterFired).toBe(true);
  });

  test('advance rejects a negative duration', () => {
    expect(() => new ManualClock(START).advance(-1)).toThrow(RangeError);
  });
});
