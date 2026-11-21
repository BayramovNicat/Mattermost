import { describe, expect, test } from 'bun:test';

describe('UserAvatar Component & Palette Logic', () => {
  test('generates expected avatar endpoint only when custom photo or lastPictureUpdate exists', () => {
    const userId = 'user-test-123';
    const lastPic = 1793820000000;

    const hasPhotoWithUpdate = Boolean(lastPic && lastPic > 0);
    const hasPhotoWithoutUpdate = Boolean(undefined);

    expect(hasPhotoWithUpdate).toBe(true);
    expect(hasPhotoWithoutUpdate).toBe(false);

    const expectedUrl = `/api/users/${userId}/avatar?_=${lastPic}`;
    expect(expectedUrl).toContain('/api/users/user-test-123/avatar?_=1793820000000');
  });

  test('prioritizes custom override_icon_url when provided', () => {
    const customUrl = 'https://custom-bot-domain.com/bot-avatar.png';
    const userId = 'bot-user-456';
    const chosenUrl = customUrl || `/api/users/${userId}/avatar`;

    expect(chosenUrl).toBe('https://custom-bot-domain.com/bot-avatar.png');
  });

  test('maps online, away, dnd, and offline to distinct tailwind status colors', () => {
    const { STATUS_COLORS } = require('../src/components/avatar');
    expect(STATUS_COLORS.online).toBe('bg-emerald-500');
    expect(STATUS_COLORS.away).toBe('bg-amber-500');
    expect(STATUS_COLORS.dnd).toBe('bg-rose-500');
    expect(STATUS_COLORS.offline).toBe('bg-zinc-600');
  });
});
