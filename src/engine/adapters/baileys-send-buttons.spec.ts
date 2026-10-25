import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysMessaging, NATIVE_FLOW_BIZ_NODE, type BaileysMessagingHost } from './baileys-messaging';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { createLogger } from '../../common/services/logger.service';

/**
 * Baileys' sendMessage generates no buttons content and builds its own stanza nodes, so a buttons
 * message is generated and relayed directly. These assertions pin the two things WhatsApp needs
 * to render it (the native-flow payload and the `biz` node) and that the send still gets the same
 * recipient check, ephemeral timer and bookkeeping as every sendMessage-based send.
 */

const logger = createLogger('baileys-send-buttons.spec');

const CHAT = '628111@s.whatsapp.net';

function makeMessaging(options: { ephemeral?: number; registered?: boolean } = {}) {
  const sock = {
    user: { id: '628177:3@s.whatsapp.net' },
    onWhatsApp: jest.fn((jid: string) => Promise.resolve([{ jid, exists: options.registered ?? true }])),
    relayMessage: jest.fn().mockResolvedValue('BTN-1'),
    sendMessage: jest.fn(),
  };
  const lib = {
    generateMessageIDV2: jest.fn(() => 'BTN-1'),
    generateWAMessageFromContent: jest.fn((jid: string, message: unknown) => ({
      key: { id: 'BTN-1', remoteJid: jid, fromMe: true },
      message,
      messageTimestamp: 1,
    })),
    normalizeMessageContent: (m: unknown) => m,
    getContentType: (m: Record<string, unknown>) => Object.keys(m)[0],
  };
  const putStoredMessage = jest.fn(() => Promise.resolve());
  const recordMessage = jest.fn();
  const host = {
    ensureReady: jest.fn(),
    sessionProxyUrl: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    getSocketOrNull: () => sock as unknown as WASocket,
    logger,
    toNeutralJid: (j: string) => j,
    toEngineJid: (j: string) => j,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    getEphemeralExpiration: () => options.ephemeral,
    toUnixSeconds: () => 1,
    loadLib: () => Promise.resolve(lib as never),
    putStoredMessage,
    recordMessage,
    rememberOwnSend: jest.fn(),
    recordLidMapping: () => undefined,
    getOnMessageCreate: () => undefined,
    mapMessage: () => Promise.resolve({} as never),
  } as unknown as BaileysMessagingHost;
  return { messaging: new BaileysMessaging(host), sock, lib, putStoredMessage, recordMessage };
}

const INPUT = {
  body: 'Return to the main menu?',
  buttons: [
    { id: '1', text: 'Yes' },
    { id: '2', text: 'No' },
  ],
};

describe('BaileysMessaging.sendButtonsMessage', () => {
  it('relays a native-flow interactiveMessage with one quick_reply per button', async () => {
    const { messaging, sock, lib } = makeMessaging();

    const result = await messaging.sendButtonsMessage(CHAT, { ...INPUT, header: 'Menu', footer: 'Hafez' });

    expect(result).toEqual({ id: 'BTN-1', timestamp: 1 });
    expect(sock.sendMessage).not.toHaveBeenCalled();
    const [jid, content] = lib.generateWAMessageFromContent.mock.calls[0];
    expect(jid).toBe(CHAT);
    expect(content).toEqual({
      interactiveMessage: {
        body: { text: 'Return to the main menu?' },
        header: { title: 'Menu', hasMediaAttachment: false },
        footer: { text: 'Hafez' },
        nativeFlowMessage: {
          buttons: [
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: '1' }) },
            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'No', id: '2' }) },
          ],
        },
      },
    });
  });

  it('attaches the biz node and the generated message id to the relay', async () => {
    const { messaging, sock } = makeMessaging();

    await messaging.sendButtonsMessage(CHAT, INPUT);

    expect(sock.relayMessage).toHaveBeenCalledWith(CHAT, expect.any(Object), {
      messageId: 'BTN-1',
      additionalNodes: [NATIVE_FLOW_BIZ_NODE],
    });
  });

  it('leaves out header and footer when they are not given', async () => {
    const { messaging, lib } = makeMessaging();

    await messaging.sendButtonsMessage(CHAT, INPUT);

    const [, content] = lib.generateWAMessageFromContent.mock.calls[0] as unknown as [
      string,
      { interactiveMessage: object },
    ];
    expect(Object.keys(content.interactiveMessage)).toEqual(['body', 'nativeFlowMessage']);
  });

  it("honours the chat's disappearing-messages timer", async () => {
    const { messaging, lib } = makeMessaging({ ephemeral: 86400 });

    await messaging.sendButtonsMessage(CHAT, INPUT);

    const [, , options] = lib.generateWAMessageFromContent.mock.calls[0] as unknown as [string, unknown, object];
    expect(options).toMatchObject({ ephemeralExpiration: 86400, userJid: '628177:3@s.whatsapp.net' });
  });

  it('stores the sent message and makes it the chat preview', async () => {
    const { messaging, putStoredMessage, recordMessage } = makeMessaging();

    await messaging.sendButtonsMessage(CHAT, INPUT);

    expect(putStoredMessage).toHaveBeenCalledTimes(1);
    expect(recordMessage).toHaveBeenCalledTimes(1);
    expect(recordMessage.mock.calls[0]).toEqual([
      expect.objectContaining({ key: { id: 'BTN-1', remoteJid: CHAT, fromMe: true } }),
      'text',
    ]);
  });

  it('refuses an unregistered recipient before relaying anything', async () => {
    const { messaging, sock } = makeMessaging({ registered: false });

    await expect(messaging.sendButtonsMessage(CHAT, INPUT)).rejects.toThrow('not registered');
    expect(sock.relayMessage).not.toHaveBeenCalled();
  });

  it('reports a relay that fails after the socket went away as not ready', async () => {
    const { messaging, sock } = makeMessaging();
    let live = true;
    (messaging as unknown as { host: BaileysMessagingHost }).host.getSocketOrNull = () =>
      live ? (sock as unknown as WASocket) : null;
    sock.relayMessage.mockImplementation(() => {
      live = false;
      return Promise.reject(new Error('connection closed'));
    });

    await expect(messaging.sendButtonsMessage(CHAT, INPUT)).rejects.toBeInstanceOf(EngineNotReadyError);
  });
});
