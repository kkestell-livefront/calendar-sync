import type { Page } from "playwright";
import type { CalendarEvent, Email } from "./types.ts";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const DATE_TITLE_REGEX =
  /\b(AM|PM)\b|\b(Sun|Mon|Tue|Wed|Thu|Fri|Sat|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

export async function scrapeO365Inbox(page: Page): Promise<Email[]> {
  await page.waitForFunction(
    () =>
      window.location.hostname.includes("outlook.") &&
      !!document.querySelector('div[role="option"][data-convid]'),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS, polling: 2000 },
  );
  await page.waitForTimeout(1500);

  return page.$$eval(
    'div[role="option"][data-convid]',
    (rows, dateRegexSource) => {
      const dateRegex = new RegExp(dateRegexSource);
      return rows.map((row) => {
        const id = row.getAttribute("data-convid") ?? "";
        const ariaLabel = row.getAttribute("aria-label") ?? "";
        const unread = /(^|\s)Unread(\s|$)/.test(ariaLabel);

        const titleSpans = Array.from(row.querySelectorAll("span[title]"));

        const senderSpan = titleSpans.find((el) => /@/.test(el.getAttribute("title") ?? ""));
        const sender = senderSpan?.textContent?.trim() ?? "";
        const senderEmail = senderSpan?.getAttribute("title")?.trim() ?? "";

        const dateCandidates = titleSpans.filter((el) => {
          const t = el.getAttribute("title") ?? "";
          return t.length > 0 && dateRegex.test(t);
        });
        const dateSpan = dateCandidates[dateCandidates.length - 1];
        const dateDisplay = dateSpan?.textContent?.trim() ?? "";
        const dateTitle = dateSpan?.getAttribute("title")?.trim() ?? "";
        const date = dateTitle || dateDisplay;

        let remaining = ariaLabel;
        remaining = remaining.replace(/^Unread\s+/, "");
        remaining = remaining.replace(/^External sender\s+/, "");
        remaining = remaining.replace(/\s*No conversations selected\s*$/, "");
        if (sender && remaining.startsWith(sender)) {
          remaining = remaining.slice(sender.length).trimStart();
        }

        let subject = "";
        let snippet = "";
        if (dateDisplay) {
          const idx = remaining.indexOf(" " + dateDisplay + " ");
          if (idx >= 0) {
            subject = remaining.slice(0, idx).trim();
            snippet = remaining.slice(idx + dateDisplay.length + 2).trim();
          } else if (remaining.endsWith(" " + dateDisplay)) {
            subject = remaining.slice(0, remaining.length - dateDisplay.length - 1).trim();
          } else {
            subject = remaining.trim();
          }
        } else {
          subject = remaining.trim();
        }

        return { id, sender, senderEmail, subject, snippet, date, unread };
      });
    },
    DATE_TITLE_REGEX.source,
  );
}

export async function scrapeO365Calendar(page: Page): Promise<CalendarEvent[]> {
  await page.waitForFunction(
    () =>
      window.location.hostname.includes("outlook.") &&
      (!!document.querySelector('div[data-app-section="calendar-view-0"]') ||
        !!document.querySelector('div[data-app-section="Surface_Week"]')),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS, polling: 2000 },
  );
  await page.waitForTimeout(2500);

  const raw = await page.$$eval('div[role="button"][aria-label]', (nodes) =>
    nodes
      .map((node) => node.getAttribute("aria-label") ?? "")
      .filter(
        (aria) =>
          aria.length > 0 &&
          / to \d{1,2}:\d{2}\s*(?:AM|PM)/i.test(aria) &&
          /\b\d{4}\b/.test(aria) &&
          !/^Canceled:/i.test(aria),
      ),
  );

  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  for (const aria of raw) {
    const parsed = parseOutlookAria(aria);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    events.push(parsed);
  }
  return events;
}

const OUTLOOK_RE =
  /^(.+?), (\d{1,2}:\d{2}\s*(?:AM|PM)) to (\d{1,2}:\d{2}\s*(?:AM|PM)), (?:[A-Za-z]+, )?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},\s+\d{4})(?:,|$)/;

function parseOutlookAria(aria: string): CalendarEvent | null {
  const match = aria.match(OUTLOOK_RE);
  if (!match) return null;
  const [, titleRaw, startStr, endStr, dateStr] = match;
  const title = titleRaw.trim();
  const start = new Date(`${dateStr} ${startStr}`);
  const end = new Date(`${dateStr} ${endStr}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);
  const startIso = start.toISOString();
  const endIso = end.toISOString();
  return {
    id: `${title}|${startIso}|${endIso}`,
    title,
    start: startIso,
    end: endIso,
    allDay: false,
    calendarName: "Outlook Calendar",
  };
}
