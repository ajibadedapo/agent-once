export type TargetName = 'checkout' | 'booking' | 'email' | 'ticket';

export const TARGET_NAMES: readonly TargetName[] = ['checkout', 'booking', 'email', 'ticket'];

export interface TargetField {
  name: string;
  label: string;
  example: string;
  multiline?: boolean;
}

export interface TargetSpec {
  name: TargetName;
  title: string;
  historyTitle: string;
  idPrefix: string;
  fields: readonly TargetField[];
  button: string;
  confirmedHeading: string;
  confirmation(id: string, reference: string): string;
  historyEntry(id: string): string;
}

export const TARGETS: Readonly<Record<TargetName, TargetSpec>> = {
  checkout: {
    name: 'checkout',
    title: 'Checkout',
    historyTitle: 'Checkout history',
    idPrefix: 'ORD',
    fields: [
      { name: 'item', label: 'Item', example: 'Blue mug' },
      { name: 'qty', label: 'Quantity', example: '1' },
    ],
    button: 'Place order',
    confirmedHeading: 'Order confirmed',
    confirmation: (id, reference) => `Order ${id} confirmed (reference ${reference})`,
    historyEntry: (id) => `Order ${id}`,
  },
  booking: {
    name: 'booking',
    title: 'Book a slot',
    historyTitle: 'Booking history',
    idPrefix: 'BK',
    fields: [
      { name: 'slot', label: 'Slot', example: '2026-11-03 10:00' },
      { name: 'name', label: 'Name', example: 'Sam Rivers' },
    ],
    button: 'Book slot',
    confirmedHeading: 'Booking confirmed',
    confirmation: (id, reference) => `Booking ${id} confirmed (reference ${reference})`,
    historyEntry: (id) => `Booking ${id}`,
  },
  email: {
    name: 'email',
    title: 'Send an email',
    historyTitle: 'Email history',
    idPrefix: 'MSG',
    fields: [
      { name: 'to', label: 'To', example: 'team@example.test' },
      { name: 'subject', label: 'Subject', example: 'Weekly update' },
      { name: 'body', label: 'Message', example: 'All on track.', multiline: true },
    ],
    button: 'Send message',
    confirmedHeading: 'Message sent',
    confirmation: (id, reference) => `Message ${id} sent (reference ${reference})`,
    historyEntry: (id) => `Message ${id}`,
  },
  ticket: {
    name: 'ticket',
    title: 'Open a support ticket',
    historyTitle: 'Ticket history',
    idPrefix: 'TCK',
    fields: [
      { name: 'title', label: 'Title', example: 'Printer jam' },
      { name: 'body', label: 'Details', example: 'Second floor printer is jammed.', multiline: true },
    ],
    button: 'Create ticket',
    confirmedHeading: 'Ticket created',
    confirmation: (id, reference) => `Ticket ${id} created (reference ${reference})`,
    historyEntry: (id) => `Ticket ${id}`,
  },
};

export function isTargetName(value: unknown): value is TargetName {
  return typeof value === 'string' && (TARGET_NAMES as readonly string[]).includes(value);
}
