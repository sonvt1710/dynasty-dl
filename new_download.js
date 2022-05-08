const fs = require('fs-extra');
const https = require('https');
const path = require('path');
const progress = require('progress');
const commander = require('commander');

const packageJson = require('./package.json');

const URL = require('url').URL;
const BASE_URL = "https://dynasty-scans.com/";
const CHAPTER_PERMA = "https://dynasty-scans.com/chapters/";
const JSON_APPENDIX = ".json";

let argv = {};

run();

// Some OS (Windows) don't like them in the pathnam, so they trhow tantrum
function legalize(text, replacer = '_') {
  return text.replace(/\\|\/|:|\*|\?|"|<|>/g, replacer);
}

function newProgress(total, extra = '') {
  return new progress(`\t(:current/:total) [:bar] :percent ${extra}`, {
    complete: '=',
    incomplete: '.',
    width: (total <= 20) ? total : 20,
    total: total,
  })
}

async function stream(url, output) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      res.pipe((typeof output === "string" ? fs.createWriteStream(output) : output));
      res.on('end', () => resolve(res.statusCode));
      res.on('error', reject);
    })
  })
}

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const length = parseInt(res.headers['content-length'], 10);
      const lengthKnown = isNaN(length);
      const pbar = argv.verbose ? newProgress(lengthKnown ? 1 : length, `GET: ${url}`) : null;

      let capture = '';
      res
        .on('data', chunk => {
          capture += chunk;
          if (pbar) pbar.tick(lengthKnown ? 0 : chunk.length);
        })
        .once('end', () => {
          if (pbar) pbar.tick(lengthKnown ? 0 : chunk.length);
          resolve(capture);
        })
        .once('error', reject);
    })
  })
}

function printChapterList(main) {
  let hack = 0;
  for (let i = 0, len = main.taggings.length; i < len; i += 1) {
    const chapter = main.taggings[i];
    if (typeof chapter.header !== "undefined") {
      if (chapter.header) {
        console.log(' >> ', chapter.header); // ignore if is null
        hack += 1;
      } else {
        console.log(` ${i - hack}\t ${chapter.title}`);
      }
    }
  }
}

async function getChapter({ permalink, title, index }, mangaFolder) {
  return new Promise(async (resolve, reject) => {
    console.log('input==============', permalink, title, index);
    const chapterURL = new URL(permalink, CHAPTER_PERMA).href;
    const chapter = await get(`${chapterURL}${${JSON_APPENDIX}`);

    await stream(
      `${chapterURL}/download`,
      path.join(
        mangaFolder,
        `${legalize(title)}.zip`,
      )
    )
  })
}

async function parseManga(manga) {
  const initialJSON = await get(`${new URL(manga.url).href}${JSON_APPENDIX}`);
  const main = JSON.parse(initialJSON);
  const name = main.name || main.long_title;

  const mangaFolder = path.join(argv.output || '.', legalize(name));
  console.log('\nDownload Folder: ', mangaFolder);
  fs.ensureDir(mangaFolder);

  console.log('\n Downloading: %s\n', name);

  if (manga.isSeries && (main.type === "Series" || main.type === "Anthology" || main.type === "Author")) {
    if (argv.listChapters) {
      printChapterList(main);
      process.exit(0);
    }
    main.taggings = main.taggings.filter(key => typeof key.header === 'undefined');
    if (manga.chapters) {
      const selection = manga.chapters.split('-');
      if (selection.length === 1) {
        main.taggings = [main.taggings[selection[0]]];
      } else if (selection.length === 2) {
        main.taggings = main.tagging.slice(selection[0], parseInt(selection[1] + 1));
      }
    }

    for (let i = 0, len = main.taggings.length; i < len; i += 1) {
      await getChapter({ ...main.taggings[i], index: i }, mangaFolder);
    }
  } else {
    await getChapter(main, true);
  }
}

async function run() {
  argv = commander
    .version(packageJson.version)
    .arguments('<url>')
    .description("Simple tool for batch-downloading from Dynasty-Scans. Supports also PDF saving as well as chapter selection.")
    .option('-v, --verbose', 'Includes progressbar for each GET request and PDF conversion.')
    .option('-p, --pdf', 'Downloads pdf instead of seperated images.')
    .option('-c, --chapters <a>-<b>', 'Chapter range.')
    .option('-C, --listChapters', 'List all chapters with correct indexes.')
    .option('-o, --output [path]', 'Different output path, defaults to current working directory.')
    .parse(process.argv);

  if (!argv.args[0]) return argv.help();

  const config = {
    output: path.resolve(argv.output || process.cwd()),
    verbose: argv.verbose,
  }
  const tempURL = new URL(argv.args[0]);

  parseManga({
    url: tempURL.origin + tempURL.pathname,
    isSeries: !argv.args[0].includes('chapters'),
    chapters: argv.chapters
  })
}
