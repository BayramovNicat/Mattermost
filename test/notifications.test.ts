import { describe, expect, test } from 'bun:test';
import {
  getNotificationPermission,
  isUserMentioned,
  showDesktopNotification,
} from '../src/services/notifications';
import { playMentionChime, playMessageChime } from '../src/services/sound';

describe('notification service', () => {
  test('detects direct user mentions', () => {
    expect(isUserMentioned('Hello @john, how are you?', 'john')).toBe(true);
    expect(isUserMentioned('@john check this out', 'john')).toBe(true);
    expect(isUserMentioned('Great work (@john)!', 'john')).toBe(true);
    expect(isUserMentioned('Can you review this? @JOHN', 'john')).toBe(true);
  });

  test('detects broadcast mentions (@all, @channel, @here)', () => {
    expect(isUserMentioned('FYI @all meeting starts in 5m', 'john')).toBe(true);
    expect(isUserMentioned('@channel please review PR #42', 'john')).toBe(true);
    expect(isUserMentioned('Is @here available?', 'john')).toBe(true);
  });

  test('ignores non-mentions and substrings', () => {
    expect(isUserMentioned('Contact support@example.com for help', 'example')).toBe(false);
    expect(isUserMentioned('Hey john, did you see this?', 'john')).toBe(false);
    expect(isUserMentioned('Look at @johnathan please', 'john')).toBe(false);
    expect(isUserMentioned('', 'john')).toBe(false);
    expect(isUserMentioned('Hello world', undefined)).toBe(false);
  });

  test('safely falls back when window/Notification is unavailable', () => {
    expect(getNotificationPermission()).toBe('denied');
    expect(
      showDesktopNotification({
        title: 'Test',
        body: 'Message',
      })
    ).toBeNull();
  });

  test('passes renotify: true when tag is set and handles onclick', () => {
    const originalWindow = globalThis.window;
    const originalNotification = globalThis.Notification;
    const calls: Array<{ title: string; options: NotificationOptions & { renotify?: boolean } }> = [];
    let closed = false;
    let focused = false;
    let clicked = false;

    class MockNotification {
      static permission: NotificationPermission = 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options: NotificationOptions & { renotify?: boolean }) {
        calls.push({ title, options });
      }
      close() {
        closed = true;
      }
    }

    (globalThis as unknown as { window: unknown }).window = {
      Notification: MockNotification,
      focus: () => {
        focused = true;
      },
    };
    (globalThis as unknown as { Notification: unknown }).Notification = MockNotification;

    try {
      const notif = showDesktopNotification({
        title: 'General - @alice',
        body: 'Hello there',
        tag: 'channel-1',
        onClick: () => {
          clicked = true;
        },
      });
      expect(notif).not.toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0].options.renotify).toBe(true);
      expect(calls[0].options.tag).toBe('channel-1');
      expect(closed).toBe(false);

      notif?.onclick?.({} as Event);
      expect(focused).toBe(true);
      expect(clicked).toBe(true);
      expect(closed).toBe(true);
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
      (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    }
  });
});

describe('sound service', () => {
  test('executes chime functions safely in non-browser environments without error', () => {
    expect(() => playMessageChime()).not.toThrow();
    expect(() => playMentionChime()).not.toThrow();
  });
});
