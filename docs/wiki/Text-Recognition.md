Stepthrough can read the text on every screenshot. Turn on **read text (ocr)** before an analysis, or press **read text**
beside **export** for a run that is done. Finding steps does not wait for it: the steps are there first and the text
follows, as **reading text, 12 of 66, ready in about 2 min** says. Runs take turns, so the time can grow when others ask
for text too. You can go on working or close the page meanwhile, and **stop** leaves the rest unread. The text of a step
you add by hand is read too.

## Inspecting, searching, and exporting text

- **text** on a card shows what was read, line by line. In the gallery view it also marks where each line is: point at a
  line to see its place, or at the screenshot to see its line. The text stays open as you go through the steps.
- **find text** shows only the steps with the words you type, in any order; put words that belong together between
  quotation marks. Case and accents do not matter.
- The export has the text in `ocr_text`, and each line with its place in `text_lines` (in `steps.json`). It also has the
  text of each screenshot as **PAGE XML**, in `images/page`, for tools made to correct and work with recognised text, such
  as Transkribus and eScriptorium: they open the `images` folder with its text as it is.

## Languages and limits

It reads the Latin alphabet with the accents of European languages, Chinese and Japanese; not Cyrillic, Greek, Arabic,
Hebrew, Korean or the scripts of India and South-East Asia. It is made for the text of interfaces, which stands upright
in lines: text that is turned, handwritten or drawn can be missed, and an icon can be read as a letter. So check the
words you quote against the screenshot. Reading happens where Stepthrough runs, and nothing is sent anywhere.

See [Evaluation and benchmarks](Evaluation-and-Benchmarks.md#text-recognition) for measured accuracy across screen
sizes and languages.

## Text read by earlier versions

**Text read by an earlier version** (up to 1.4.5) can be wrong: to save time, those versions gave a screen the text of an
earlier one that looked much like it. **read again** replaces it, also in runs from long ago. In an export, `text_state`
is `earlier` for such text.

For configuring text readers and offline OCR models on a server, see
[Server deployment (Docker)](Server-Deployment-Docker.md#text-recognition-ocr) or
[Server deployment (without Docker)](Server-Deployment-Without-Docker.md#text-recognition-models).
