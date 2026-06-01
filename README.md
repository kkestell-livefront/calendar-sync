# Calendar Sync

Scrapes your Gmail inbox and Google Calendar alongside your O365 (work) inbox and calendar, then syncs work calendar events into a dedicated Google Calendar. Saves all emails and events to `output.json`.

## How it works

The script launches a persistent Playwright (Chromium) browser for each account. Browser sessions are saved under `profiles/` so you only need to log in once per account. On subsequent runs the browser starts headless and reuses the saved session.

After scraping, it diffs your work calendar against the target Google Calendar and creates or deletes events to bring them into sync.

## Prerequisites

- Node.js 22+
- `npm install` (installs Playwright and its Chromium browser)

## Setup

1. Copy the sample config and fill in your accounts:

   ```sh
   cp config.sample.json config.json
   ```

2. Edit `config.json`:

   | Key                 | Description                                                                     |
   | ------------------- | ------------------------------------------------------------------------------- |
   | `gmailAccount`      | The Google account that owns the destination calendar                           |
   | `o365Account`       | The O365 / work account whose calendar is the source                            |
   | `destinationCalendarName` | Name of the Google Calendar where work events are written                  |
   | `outputPath`        | _(optional)_ Path to write scraped data as JSON. Omit to skip writing the file. |

   `config.json` is gitignored and never committed.

## Usage

```sh
npm run scrape
```

On first run, a visible browser window opens so you can log in to each account. Once authenticated the session is saved and future runs are fully headless.

## Output

`output.json` — all scraped emails and calendar events from both accounts:

```json
{
  "emails": [...],
  "events": [...]
}
```
