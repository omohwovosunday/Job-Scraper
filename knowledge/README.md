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
```

then run `npm run seed:knowledge` to push them into Supabase.
