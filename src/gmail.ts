import type { Page } from "playwright";
import type { CalendarEvent, Email } from "./types.ts";

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const GMAIL_JSLOG_SEGMENT_RE = "\\b1:([A-Za-z0-9+/=]+)";
const GMAIL_THREAD_RE = "#thread-([fa]):([\\w-]+)";

export async function scrapeGmailInbox(page: Page): Promise<Email[]> {
  // waitForFunction re-evaluates on each poll, so it survives the login redirect
  // from accounts.google.com back to mail.google.com
  await page.waitForFunction(
    () =>
      window.location.hostname.includes("mail.google.com") &&
      !!document.querySelector("tr.zA"),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS, polling: 2000 },
  );
  await page.waitForTimeout(1500);

  return page.$$eval(
    "tr.zA",
    (rows, regexes) => {
      const segmentRe = new RegExp(regexes.segment);
      const threadRe = new RegExp(regexes.thread);
      return rows.map((row) => {
        const text = (selector: string) =>
          row.querySelector(selector)?.textContent?.trim() ?? "";
        const emailEl =
          row.querySelector(".yW span[email]") ?? row.querySelector("span[email]");
        const nameEl = row.querySelector(".yW span");
        const dateEl = row.querySelector(".xW span[title], .xW span");

        let id = "";
        const segment = (row.getAttribute("jslog") ?? "").match(segmentRe);
        if (segment) {
          try {
            const m = atob(segment[1]).match(threadRe);
            if (m) id = `${m[1]}:${m[2]}`;
          } catch {
            /* ignore */
          }
        }

        return {
          id,
          sender:
            emailEl?.getAttribute("name") ||
            emailEl?.textContent?.trim() ||
            nameEl?.textContent?.trim() ||
            "",
          senderEmail: emailEl?.getAttribute("email") ?? "",
          subject: text(".y6 span.bog") || text(".y6"),
          snippet: text(".y2"),
          date: dateEl?.getAttribute("title") ?? dateEl?.textContent?.trim() ?? "",
          unread: row.classList.contains("zE"),
        };
      });
    },
    { segment: GMAIL_JSLOG_SEGMENT_RE, thread: GMAIL_THREAD_RE },
  );
}

export async function scrapeGoogleCalendar(page: Page): Promise<CalendarEvent[]> {
  await page.waitForFunction(
    () =>
      window.location.hostname.includes("calendar.google.com") &&
      !!document.querySelector('[role="button"][data-eventid]'),
    undefined,
    { timeout: LOGIN_TIMEOUT_MS, polling: 2000 },
  );
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __gcCount?: number; __gcStable?: number };
      const n = document.querySelectorAll('[role="button"][data-eventid]').length;
      if (n === w.__gcCount) {
        w.__gcStable = (w.__gcStable ?? 0) + 1;
      } else {
        w.__gcCount = n;
        w.__gcStable = 0;
      }
      return (w.__gcStable ?? 0) >= 3;
    },
    { polling: 1000, timeout: 30_000 },
  ).catch(() => {});

  const raw = await page.$$eval('[role="button"][data-eventid]', (nodes) =>
    nodes.map((node) => ({
      id: (node as HTMLElement).dataset.eventid ?? "",
      aria: node.getAttribute("aria-label") ?? "",
      title: (node.textContent ?? "").trim(),
    })),
  );

  return raw
    .map(({ id, aria, title }) => parseGoogleCalendarAria(id, aria, title))
    .filter((e): e is CalendarEvent => e !== null);
}

const GOOGLE_DATE_RE =
  /,\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*)\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?,\s+(\d{4})\s*$/;
const GOOGLE_TIME_RANGE_RE =
  /^(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s+to\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*,\s*/i;
const GOOGLE_LOCATION_RE =
  /,\s*Location:\s*([^,]*(?:,\s*[^,]*)*?)\s*,\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/;
const GOOGLE_CALENDAR_RE = /,\s*Calendar:\s*([^,]+?)\s*,/;

function normalizeAmPm(time: string): string {
  const match = time.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!match) return time;
  const [, hour, minutes = "00", period] = match;
  return `${hour}:${minutes} ${period.toUpperCase()}`;
}

function parseGoogleCalendarAria(id: string, aria: string, title: string): CalendarEvent | null {
  if (!id || !aria) return null;

  const dateMatch = aria.match(GOOGLE_DATE_RE);
  if (!dateMatch) return null;
  const [, month, startDay, endDay, year] = dateMatch;
  const startDateStr = `${month} ${startDay}, ${year}`;
  const endDateStr = endDay ? `${month} ${endDay}, ${year}` : startDateStr;

  const allDay = /^All day,/i.test(aria);
  let startIso = "";
  let endIso = "";

  if (allDay) {
    const s = new Date(`${startDateStr} 00:00`);
    const e = new Date(`${endDateStr} 00:00`);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
    startIso = s.toISOString();
    endIso = new Date(e.getTime() + 24 * 60 * 60 * 1000).toISOString();
  } else {
    const timeMatch = aria.match(GOOGLE_TIME_RANGE_RE);
    if (!timeMatch) return null;
    const start = new Date(`${startDateStr} ${normalizeAmPm(timeMatch[1])}`);
    const end = new Date(`${startDateStr} ${normalizeAmPm(timeMatch[2])}`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);
    startIso = start.toISOString();
    endIso = end.toISOString();
  }

  const calendarMatch = aria.match(GOOGLE_CALENDAR_RE);
  const locationMatch = aria.match(GOOGLE_LOCATION_RE);

  return {
    id,
    title: title || aria,
    start: startIso,
    end: endIso,
    allDay,
    location: locationMatch ? locationMatch[1].trim() : undefined,
    calendarName: calendarMatch ? calendarMatch[1].trim() : "Google Calendar",
  };
}
