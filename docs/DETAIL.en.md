# Novel voices (LaiVox)

Turn TXT, EPUB, and text-based PDF novels into playable audio in DeepSeek Harness, or read chat messages aloud.

## What you can do

- Import TXT, EPUB, or text-based PDF books and organize them into chapters.
- Produce single-voice or multi-voice narration. Edge Online Speech is the default and needs no account. Paid LaiVox members can switch engines in Settings → Production, use their LaiVox speech quota, and select voices they uploaded in the LaiVox browser extension.
- Use `/laivox` in chat or ask AI to propose a reading. Confirm below the reply before AI cleanup or scripting begins.
- Use **Read aloud with Edge** next to an assistant message, or ask the assistant to read aloud.
- Ask AI to search the bookshelf, create books, append chapters, preview TXT, EPUB, or PDF files from the workspace, or draft a production plan. You confirm imports and production. You can also import files delivered in chat from their file actions.
- Play at different speeds, set a sleep timer, jump to a segment, and export MP3 or WAV.

## Chat and playback

- Reading proposals, production plans, and import previews appear under the latest reply with confirmation controls. The tool card also lets you confirm.
- The LaiVox bar above the chat box shows pending items, production progress, and the option to continue listening. Use × to hide it or adjust when it appears in Settings.
- Recent results appear at the end of the latest turn. Preview in chat or open the chapter in the workbench.
- Reading a reply aloud pauses the novel. The mini player offers **Continue listening** at the end.
- Chat audio is grouped by conversation under Bookshelf → Chat audio. Inactive items expire after the configurable retention period, which defaults to seven days.

## Language and data

- Choose Simplified Chinese, Traditional Chinese, or English in DSH Settings → General → Language. The workbench follows the selected language.
- All book data is stored in the Profile's `dsh-laivox-tts` folder. The legacy `laivox-novel-audio` folder is not migrated automatically. Older plugin versions cannot open the current v12 database. Back it up before upgrading.
- On a fresh empty profile, first launch seeds two ready-to-play sample books (Edge single-narrator reading generated with Microsoft Edge online speech and LaiVox multi-role performance using preset voices) without requiring an API key. Deleting them keeps them removed across restarts and upgrades.
- Reading aloud sends text to Microsoft’s Edge speech service.
