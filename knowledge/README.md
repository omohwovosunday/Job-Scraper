# knowledge/

**This directory is gitignored except for this file.**

It holds the candidate profile, voice standard and case studies — the material that
drives scoring and drafting. It is personal and commercially sensitive, and this
repository is public, so none of it is committed.

The canonical copies live in the Supabase `knowledge` table. The worker fetches them
at the start of each run and caches in memory for the run's duration, so editing a
case study is a database update, not a deploy.

To populate a local working copy for development, place the files here:

```
knowledge/
  profile.md
  voice-sample.md
  case-studies/
    rentos.md
    payafta.md
    pocketlawyers.md
    vouchera.md
  resumes/
    build-resumes.mjs
    Sunday-Omohwovo-product-design.pdf
    Sunday-Omohwovo-design-engineer.pdf
    Sunday-Omohwovo-ai-training.pdf
```

then run `npm run seed:knowledge` to push them into Supabase.

## Resumes

The three variants are attachments, not knowledge rows — they are never seeded. The
filename stems must stay identical to `RESUME_VARIANTS` in `worker/llm/config.ts`,
because the scorer emits one of those strings and the drafter attaches the file
named after it; renaming a file here breaks the attachment silently.

Regenerate with `node knowledge/resumes/build-resumes.mjs`, which prints through
headless Chrome, then publish with `npm run sync:resumes`.

That second step is not optional once the cron is on. This directory is gitignored,
so a GitHub Actions checkout has no PDFs at all, and the sender refuses to send an
application with nothing attached rather than mailing a bare letter to a real hiring
manager. The private `resumes` bucket in Supabase Storage is the copy a scheduled
run can reach. Local files win when both exist, so a freshly regenerated PDF is used
immediately rather than losing silently to a stale upload — which is also why the
sync is a step you have to remember. `npm run verify:storage` checks the bucket is
present, private, and complete.

Never make that bucket public. The PDFs carry a real name, email, employer history
and city, and a public bucket puts them on a guessable URL for anyone who learns the
project id.

Two further properties are load-bearing and worth re-checking after any edit:

- **The contact email must match `GMAIL_USER`.** Applications send from that
  address and its inbox is the only one the pipeline reads. A resume advertising a
  different mailbox routes anyone who types the address rather than hitting reply
  somewhere nothing is watching.
- **Hyphenated compounds must survive extraction.** If a line breaks at the hyphen
  in "high-fidelity", the text layer yields "highfidelity" and an ATS keyword search
  misses it. The generator wraps them to prevent the break; verify with
  `pdftotext file.pdf - | grep -i highfidelity` returning nothing.
