import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { BUTTON_TEXT_MAX_LENGTH, SendButtonsDto } from './message-actions.dto';

// Same implicit conversion as the global pipe (src/config/app-validation.ts).
function errorsFor(obj: object): Promise<ValidationError[]> {
  return validate(plainToInstance(SendButtonsDto, obj, { enableImplicitConversion: true }));
}

const VALID = {
  chatId: '628111@c.us',
  body: 'Return to the main menu?',
  buttons: [
    { id: '1', text: 'Yes' },
    { id: '2', text: 'No' },
  ],
};

describe('SendButtonsDto', () => {
  it('accepts a body with two buttons', async () => {
    expect(await errorsFor(VALID)).toHaveLength(0);
  });

  it('accepts an optional header and footer', async () => {
    expect(await errorsFor({ ...VALID, header: 'Menu', footer: 'Hafez Gallery' })).toHaveLength(0);
  });

  it('rejects an empty button list', async () => {
    const errs = await errorsFor({ ...VALID, buttons: [] });
    expect(errs.map(e => e.property)).toContain('buttons');
  });

  it('rejects more than three buttons', async () => {
    const buttons = ['1', '2', '3', '4'].map(id => ({ id, text: `Option ${id}` }));
    const errs = await errorsFor({ ...VALID, buttons });
    expect(errs.map(e => e.property)).toContain('buttons');
  });

  it('rejects a label longer than WhatsApp shows', async () => {
    const errs = await errorsFor({ ...VALID, buttons: [{ id: '1', text: 'x'.repeat(BUTTON_TEXT_MAX_LENGTH + 1) }] });
    expect(errs.map(e => e.property)).toContain('buttons');
  });

  it('rejects a button without an id', async () => {
    const errs = await errorsFor({ ...VALID, buttons: [{ text: 'Yes' }] });
    expect(errs.map(e => e.property)).toContain('buttons');
  });

  // Without ToStrictArray a JSON object arrives as an empty array, which the size check alone accepts.
  it('rejects an object in place of the button array', async () => {
    const errs = await errorsFor({ ...VALID, buttons: { 1: 'Yes' } });
    expect(errs.map(e => e.property)).toContain('buttons');
  });

  it('rejects an empty body', async () => {
    const errs = await errorsFor({ ...VALID, body: '' });
    expect(errs.map(e => e.property)).toContain('body');
  });
});
