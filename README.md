# Upload-Post Social Publisher

Publish or schedule social media posts from a GitHub workflow with [Upload-Post](https://www.upload-post.com).
One step posts to **TikTok, Instagram, YouTube, LinkedIn, Facebook, X, Threads, Pinterest, Bluesky,
Discord, Telegram and Google Business Profile**.

Typical uses:

- announce a new release on X, LinkedIn and Bluesky
- publish a video as soon as it is pushed to a folder of the repository
- schedule posts from a workflow form or from a file kept in the repository

Built on the official [`upload-post`](https://www.npmjs.com/package/upload-post) SDK.

## Setup

1. Create an account at [upload-post.com](https://www.upload-post.com), create a **profile** and connect
   your social accounts to it in [Manage Users](https://app.upload-post.com/manage-users).
   The profile name is what you pass as `profile`.
2. Create an API key in [API Keys](https://app.upload-post.com/api-keys).
3. In your repository, go to **Settings → Secrets and variables → Actions → New repository secret**,
   name it `UPLOAD_POST_API_KEY` and paste the key. Or with the GitHub CLI:

   ```bash
   gh secret set UPLOAD_POST_API_KEY
   ```

Never write the key in the workflow file. The action masks it in the logs.

## Examples

### Announce a release

```yaml
name: Announce release
on:
  release:
    types: [published]

permissions:
  contents: read

jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - uses: Upload-Post/upload-post-action@v1
        with:
          api-key: ${{ secrets.UPLOAD_POST_API_KEY }}
          profile: my-brand
          platforms: x, linkedin, bluesky, threads
          text: |
            ${{ github.event.repository.name }} ${{ github.event.release.tag_name }} is out!
            ${{ github.event.release.html_url }}
```

### Publish a new video pushed to a folder

Runs when a video lands in `videos/`, uploads the file from the repository and waits for the post URLs.

```yaml
name: Publish new video
on:
  push:
    branches: [main]
    paths: ['videos/**.mp4']

permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 2
          lfs: true   # if your videos are stored with Git LFS

      - name: Find the video added by this push
        id: video
        run: |
          file=$(git diff --name-only --diff-filter=A HEAD~1 HEAD -- 'videos/*.mp4' | head -n 1)
          echo "path=$file" >> "$GITHUB_OUTPUT"

      - uses: Upload-Post/upload-post-action@v1
        if: steps.video.outputs.path != ''
        id: post
        with:
          api-key: ${{ secrets.UPLOAD_POST_API_KEY }}
          profile: my-brand
          type: video
          platforms: tiktok, instagram, youtube
          media: ${{ steps.video.outputs.path }}
          text: ${{ github.event.head_commit.message }}
          wait: true
          extra: |
            {"privacyStatus": "public", "youtube_title": "New video"}

      - run: echo '${{ steps.post.outputs.post-urls }}'
```

### Schedule a post by hand

```yaml
name: Schedule a post
on:
  workflow_dispatch:
    inputs:
      text:
        description: Post text
        required: true
      when:
        description: Publish at (ISO-8601, e.g. 2026-12-31T18:00:00)
        required: true
      platforms:
        description: Platforms
        default: x, linkedin

permissions:
  contents: read

jobs:
  schedule:
    runs-on: ubuntu-latest
    steps:
      - uses: Upload-Post/upload-post-action@v1
        id: post
        with:
          api-key: ${{ secrets.UPLOAD_POST_API_KEY }}
          profile: my-brand
          platforms: ${{ inputs.platforms }}
          text: ${{ inputs.text }}
          scheduled-date: ${{ inputs.when }}
          timezone: Europe/Madrid

      - run: echo "Scheduled as job ${{ steps.post.outputs.job-id }}"
```

### Schedule posts from a file in the repository

Keep a `social/posts.json` in the repository and schedule every entry when it changes:

```json
[
  { "text": "Webinar tomorrow at 17:00 CET", "platforms": "x,linkedin", "date": "2026-11-03T09:00:00" },
  { "text": "Webinar starts in one hour", "platforms": "x,bluesky", "date": "2026-11-04T16:00:00" }
]
```

```yaml
name: Schedule posts from file
on:
  push:
    branches: [main]
    paths: ['social/posts.json']

permissions:
  contents: read

jobs:
  read:
    runs-on: ubuntu-latest
    outputs:
      posts: ${{ steps.read.outputs.posts }}
    steps:
      - uses: actions/checkout@v7
      - id: read
        run: echo "posts=$(jq -c . social/posts.json)" >> "$GITHUB_OUTPUT"

  schedule:
    needs: read
    runs-on: ubuntu-latest
    strategy:
      matrix:
        post: ${{ fromJSON(needs.read.outputs.posts) }}
    steps:
      - uses: Upload-Post/upload-post-action@v1
        with:
          api-key: ${{ secrets.UPLOAD_POST_API_KEY }}
          profile: my-brand
          platforms: ${{ matrix.post.platforms }}
          text: ${{ matrix.post.text }}
          scheduled-date: ${{ matrix.post.date }}
          timezone: Europe/Madrid
```

Each run schedules every entry again, so remove the posts that are already scheduled from the file
(or list them in [Scheduled Posts](https://docs.upload-post.com/api/schedule-posts)).

### Photos, documents and the queue

```yaml
      # Carousel from repository files and a URL
      - uses: Upload-Post/upload-post-action@v1
        with:
          api-key: ${{ secrets.UPLOAD_POST_API_KEY }}
          profile: my-brand
          type: photos
          platforms: instagram, threads, bluesky
          text: Behind the scenes
          media: |
            images/1.jpg
            images/2.jpg
            https://cdn.example.com/3.jpg

      # A PDF on LinkedIn, in the next free slot of the queue
      - uses: Upload-Post/upload-post-action@v1
        with:
          api-key: ${{ secrets.UPLOAD_POST_API_KEY }}
          profile: my-brand
          type: document
          text: Our 2026 report
          media: reports/2026.pdf
          add-to-queue: true
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | yes | | Upload-Post API key. Pass it from a secret: `${{ secrets.UPLOAD_POST_API_KEY }}`. |
| `profile` | yes | | Upload-Post profile whose connected accounts publish the post. |
| `platforms` | yes, except `document` | | Comma-separated: `tiktok`, `instagram`, `youtube`, `linkedin`, `facebook`, `x`, `threads`, `pinterest`, `bluesky`, `discord`, `telegram`, `google_business`. `document` defaults to `linkedin`. |
| `type` | no | `text` | `text`, `video`, `photos` or `document`. |
| `text` | for `text` and `document` | | Post text / caption (the API's `title`). |
| `title` | no | | Alias of `text`. |
| `media` | for `video`, `photos`, `document` | | Public URLs or paths relative to the repository root (local files are uploaded). Separate with commas or new lines. One item for `video` and `document`. |
| `scheduled-date` | no | | ISO-8601 date/time to publish at. Omit to publish now. |
| `timezone` | no | UTC | IANA timezone for `scheduled-date`, e.g. `America/New_York`. |
| `add-to-queue` | no | `false` | Use the next free slot of the profile's [queue](https://docs.upload-post.com/api/queue-system). Not combinable with `scheduled-date`. |
| `first-comment` | no | | Comment posted right after publishing (Instagram, Facebook, Threads, Bluesky, X, YouTube, LinkedIn, TikTok). |
| `wait` | no | `false` | Wait until every platform has finished and fill `post-urls`. Ignored for scheduled and queued posts. |
| `wait-timeout` | no | `900` | Seconds to wait when `wait` is `true`. |
| `extra` | no | | JSON object with more parameters from the API reference (see below). |

Which platforms accept which type: text posts go to LinkedIn, X, Facebook, Threads, Bluesky, Discord,
Telegram and Google Business; photos to every platform except YouTube; documents to LinkedIn only.

### `extra`

Any documented parameter of the endpoint behind the chosen `type`, with the name used in the API reference:
[video](https://docs.upload-post.com/api/upload-video), [photos](https://docs.upload-post.com/api/upload-photo),
[text](https://docs.upload-post.com/api/upload-text), [document](https://docs.upload-post.com/api/upload-document).
Unknown names are rejected before anything is sent, so a typo fails the step instead of being ignored.
Values can be strings, numbers, booleans, arrays or objects. For file parameters such as `thumbnail`,
a repository path is uploaded as a file.

Example for a `video` post:

```yaml
          extra: |
            {
              "facebook_page_id": "123456789",
              "pinterest_board_id": "987654321",
              "target_linkedin_page_id": "107579166",
              "privacyStatus": "unlisted",
              "privacy_level": "SELF_ONLY",
              "x_title": "Shorter text just for X",
              "external_id": "release-${{ github.event.release.tag_name }}"
            }
```

## Outputs

| Output | Description |
|---|---|
| `request-id` | `request_id` of an immediate post. Check it later with [Upload Status](https://docs.upload-post.com/api/upload-status). |
| `job-id` | `job_id` of a scheduled or queued post. |
| `status` | `pending` (accepted, not waited for), `scheduled`, `completed` or `failed`. With `wait` and a timeout, the last status seen. |
| `post-urls` | JSON object of post URLs by platform, e.g. `{"x":"https://x.com/..."}`. Filled when the result is known (`wait: true`). |

With `wait: true` the step also writes a job summary with the result of every platform.

## Errors

The step fails with the message returned by the API, for example an invalid key, a platform the plan does
not include (the message links to the upgrade page) or the monthly limit being reached. With `wait: true`
it also fails when a platform fails, and names the platforms that were already published so a re-run
does not post twice there. Platforms the profile has no account for are reported as skipped and do not
fail the step.

Immediate posts are processed in the background by Upload-Post, so without `wait` the step finishes as
soon as the post is accepted.

## Links

- [API reference](https://docs.upload-post.com/api/reference)
- [Upload Status](https://docs.upload-post.com/api/upload-status)
- [Scheduled posts](https://docs.upload-post.com/api/schedule-posts)
- [Profiles and connected accounts](https://docs.upload-post.com/api/user-profiles)
- [Pricing](https://www.upload-post.com/pricing)

## Development

```bash
npm ci
npm test              # vitest, API mocked at the transport level
npm run build         # bundles src/ into dist/index.js (commit it)
npm run check-sdk-map # the SDK option map matches the installed SDK
```

`src/documented-params.json` (the allowlist for `extra`) is generated from the API docs with
`npm run extract-params -- path/to/upload-post-docs/docs/api`, and `src/sdk-field-map.json` with
`npm run probe-sdk` after upgrading the `upload-post` SDK.

## License

[MIT](LICENSE)
