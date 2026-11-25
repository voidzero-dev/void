import { defineEmail, parseEmail, replyEmail } from 'void/email';
import { kv } from 'void/kv';

export function acceptEmail(route: string) {
  return defineEmail(async (message, _env, _ctx, info) => {
    const parsed = await parseEmail(message);
    const subject = parsed.subject ?? '(no subject)';
    await kv.put(
      `email-e2e:${subject}`,
      JSON.stringify({
        route,
        params: info?.params ?? {},
        from: message.from,
        to: message.to,
        subject,
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments.map(({ filename, mimeType }) => ({ filename, mimeType })),
      }),
      { ttl: 3600 },
    );
    if (subject.startsWith('REJECT ')) {
      message.setReject('Void email acceptance reject');
      return;
    }
    if (subject.startsWith('REPLY ')) {
      await replyEmail(message, { text: `Void email acceptance reply: ${subject}` });
    }
    if (subject.startsWith('FORWARD ')) {
      const destination = parsed.headers.find(({ key }) => key === 'x-void-e2e-forward')?.value;
      if (!destination) {
        message.setReject('x-void-e2e-forward is required for this test');
        return;
      }
      await message.forward(destination);
    }
  });
}
