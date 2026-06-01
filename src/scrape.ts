import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { type BrowserContext, type Page, chromium } from "playwright";
import { scrapeGmailInbox, scrapeGoogleCalendar } from "./gmail.ts";
import { scrapeO365Inbox, scrapeO365Calendar } from "./o365.ts";
import type { CalendarEvent } from "./types.ts";

interface Config {
  gmailAccount: string;
  o365Account: string;
  destinationCalendarName: string;
  outputPath?: string;
}

const config: Config = JSON.parse(readFileSync(join(process.cwd(), "config.json"), "utf-8"));

const PROFILES_DIR = join(process.cwd(), "profiles");
const GMAIL_ACCOUNT = config.gmailAccount;
const O365_ACCOUNT = config.o365Account;
const DESTINATION_CALENDAR_NAME = config.destinationCalendarName;

const LOGIN_HOSTS = ["accounts.google.com", "login.microsoftonline.com", "login.live.com"];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function notify(title: string, message: string): void {
  execFile("osascript", ["-e", `display notification "${message}" with title "${title}"`]);
}

let activeContext: BrowserContext | null = null;
process.on("SIGINT", async () => {
  console.log("\nInterrupted — closing browser so profile is saved...");
  await activeContext?.close().catch(() => {});
  process.exit(0);
});

async function sleep(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 2000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const wait = delayMs * attempt;
        console.log(`  [${label}] attempt ${attempt} failed — retrying in ${wait}ms...`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function probeLoginRequired(profileDir: string, url: string): Promise<boolean> {
  const context = await chromium.launchPersistentContext(profileDir, { headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return LOGIN_HOSTS.some((h) => page.url().includes(h));
  } finally {
    await context.close();
  }
}

async function waitForPageOnHost(context: BrowserContext, hostname: string): Promise<Page> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const match = context.pages().find((p) => p.url().includes(hostname));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for a page on ${hostname}`);
}

function toGCalDateFormat(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function syncKey(event: CalendarEvent): string {
  return `${event.start}|${event.end}`;
}

async function createGoogleEvent(page: Page, sourceEvent: CalendarEvent): Promise<void> {
  await withRetry(`create "${sourceEvent.title}"`, async () => {
    const start = toGCalDateFormat(sourceEvent.start);
    const end = toGCalDateFormat(sourceEvent.end);
    const url = `https://calendar.google.com/calendar/r/eventedit?text=${encodeURIComponent(sourceEvent.title)}&dates=${start}/${end}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await sleep(1500, 3000);

    const calCombobox = page.locator('[role="combobox"][aria-label="Calendar"]');
    await calCombobox.waitFor({ state: "visible", timeout: 10_000 });
    await calCombobox.click();

    const calOption = page.locator('[role="option"]').filter({ hasText: DESTINATION_CALENDAR_NAME }).first();
    await calOption.waitFor({ state: "visible", timeout: 10_000 });
    await calOption.click();
    await sleep(500, 1200);

    const saveBtn = page.locator('button:has-text("Save")').first();
    await saveBtn.waitFor({ state: "visible", timeout: 10_000 });
    await saveBtn.click();
    await page.waitForURL(/calendar\.google\.com\/calendar/, { timeout: 15_000 });
  });
}

async function deleteGoogleEvent(page: Page, googleEvent: CalendarEvent): Promise<void> {
  await withRetry(`delete "${googleEvent.title}"`, async () => {
    await page.goto("https://calendar.google.com/calendar/u/0/r/agenda", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => !!document.querySelector('[role="button"][data-eventid]'),
      { timeout: 15_000 },
    );
    await sleep(1500, 3000);

    const eventEl = page.locator(`[data-eventid="${googleEvent.id}"]`).first();
    if ((await eventEl.count()) === 0) {
      console.log(`  Warning: event ${googleEvent.id} not found in agenda view — may already be deleted.`);
      return;
    }
    await eventEl.click();
    await sleep(1000, 2000);

    const deleteBtn = page.locator('[aria-label="Delete event"]').first();
    if ((await deleteBtn.count()) === 0) {
      console.log("  Warning: Delete event button not found — skipping.");
      return;
    }
    await deleteBtn.click();
    await sleep(1000, 2000);
  });
}

async function syncO365ToGoogle(
  o365Events: CalendarEvent[],
  googleEvents: CalendarEvent[],
  page: Page,
): Promise<void> {
  const googleBlocks = googleEvents.filter((e) => e.calendarName === DESTINATION_CALENDAR_NAME);
  const o365KeySet = new Set(o365Events.map(syncKey));
  const googleBlockByKey = new Map(googleBlocks.map((e) => [syncKey(e), e]));

  const toDelete = googleBlocks.filter((e) => !o365KeySet.has(syncKey(e)));
  const toCreate = o365Events.filter((e) => !googleBlockByKey.has(syncKey(e)));

  console.log(
    `\nSync plan: ${toDelete.length} to delete, ${toCreate.length} to create, ${googleBlocks.length - toDelete.length} already in sync`,
  );

  for (const event of toDelete) {
    const localStart = new Date(event.start).toLocaleString();
    console.log(`\n[DELETE] "${event.title}" ${localStart}`);
    try {
      await deleteGoogleEvent(page, event);
      console.log("  Deleted.");
    } catch (err) {
      console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(800, 2000);
  }

  for (const event of toCreate) {
    const localStart = new Date(event.start).toLocaleString();
    const localEnd = new Date(event.end).toLocaleString();
    console.log(`\n[CREATE] "${event.title}" ${localStart} → ${localEnd}`);
    try {
      await createGoogleEvent(page, event);
      console.log("  Created.");
    } catch (err) {
      console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
    }
    await sleep(800, 2000);
  }

  if (toDelete.length === 0 && toCreate.length === 0) {
    console.log("  Nothing to do — Google Calendar already in sync.");
  }
}

async function main() {
  notify("Calendar Sync", "Scrape started");
  const allEmails: object[] = [];
  const allEvents: object[] = [];
  let o365Events: CalendarEvent[] = [];

  // Scrape O365 first
  {
    const email = O365_ACCOUNT;
    const profileDir = join(PROFILES_DIR, email);
    let context: BrowserContext | null = null;
    try {
      await mkdir(profileDir, { recursive: true });

      console.log(`\nChecking session for ${email} (o365)...`);
      const loginRequired = await probeLoginRequired(profileDir, "https://outlook.office.com/mail/");
      if (loginRequired) console.log("  Login required — opening browser window...");

      context = await chromium.launchPersistentContext(profileDir, { headless: !loginRequired });
      activeContext = context;
      const page = context.pages()[0] ?? (await context.newPage());

      console.log("  Navigating to Outlook...");
      await page.goto("https://outlook.office.com/mail/", { timeout: 30_000 });
      const emails = await scrapeO365Inbox(page);
      allEmails.push(...emails.map((e) => ({ account: email, ...e })));
      console.log(`  Got ${emails.length} emails from ${email}`);

      await sleep(1000, 2500);

      console.log("  Navigating to Outlook Calendar...");
      await page.goto("https://outlook.office.com/calendar/view/week", { timeout: 30_000 });
      const events = await scrapeO365Calendar(page);
      allEvents.push(...events.map((e) => ({ account: email, ...e })));
      console.log(`  Got ${events.length} events from ${email}`);

      o365Events = events;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nO365 scrape failed: ${msg}`);
      notify("Calendar Sync", `O365 scrape failed: ${msg}`);
    } finally {
      activeContext = null;
      await context?.close().catch(() => {});
    }
  }

  // Scrape Gmail + sync
  {
    const email = GMAIL_ACCOUNT;
    const profileDir = join(PROFILES_DIR, email);
    let context: BrowserContext | null = null;
    try {
      await mkdir(profileDir, { recursive: true });

      console.log(`\nChecking session for ${email} (gmail)...`);
      const loginRequired = await probeLoginRequired(profileDir, "https://mail.google.com/");
      if (loginRequired) console.log("  Login required — opening browser window...");

      context = await chromium.launchPersistentContext(profileDir, { headless: !loginRequired });
      activeContext = context;
      const page = context.pages()[0] ?? (await context.newPage());

      console.log("  Navigating to Gmail...");
      await page.goto("https://mail.google.com/", { timeout: 30_000 });
      const mailPage = await waitForPageOnHost(context, "mail.google.com");
      for (const p of context.pages()) {
        if (p !== mailPage) await p.close().catch(() => {});
      }

      const emails = await scrapeGmailInbox(mailPage);
      allEmails.push(...emails.map((e) => ({ account: email, ...e })));
      console.log(`  Got ${emails.length} emails from ${email}`);

      await sleep(1000, 2500);

      console.log("  Navigating to Google Calendar...");
      await mailPage.goto("https://calendar.google.com/calendar/u/0/r/agenda", { timeout: 30_000 });
      const googleEvents = await scrapeGoogleCalendar(mailPage);
      allEvents.push(...googleEvents.map((e) => ({ account: email, ...e })));
      console.log(`  Got ${googleEvents.length} events from ${email}`);

      if (o365Events.length > 0) {
        console.log("\n--- Syncing O365 calendar → Google Calendar ---");
        await syncO365ToGoogle(o365Events, googleEvents, mailPage);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nGmail scrape failed: ${msg}`);
      notify("Calendar Sync", `Gmail scrape failed: ${msg}`);
    } finally {
      activeContext = null;
      await context?.close().catch(() => {});
    }
  }

  if (config.outputPath) {
    await writeFile(config.outputPath, JSON.stringify({ emails: allEmails, events: allEvents }, null, 2));
    console.log(`\nSaved ${allEmails.length} emails and ${allEvents.length} events → ${config.outputPath}`);
  }
  notify("Calendar Sync", "Scrape complete");
  console.log("\nDone.");
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  notify("Calendar Sync", `Fatal error: ${msg}`);
  console.error(err);
  process.exit(1);
});
