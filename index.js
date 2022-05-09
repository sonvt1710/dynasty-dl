const BASEURL = 'https://dynasty-scans.com/'
const CHAPTER_PERMA = 'https://dynasty-scans.com/chapters/'
const JSON_APPENDIX = '.json'

const fs = require('fs-extra')
const https = require('https')
const mkdir = require('mkdirp').sync
const path = require('path')
const pdfkit = require('pdfkit')
const imageSize = require('imagesize')
const progress = require('progress')
const URL = require('url').URL
const pj = path.join
// for reconverting, implement an opt. dependency for sharp, a
// faster converting engine
const PNG = require('pngjs').PNG
const sharp = safeRequire('sharp')

const argv = require('commander')
	.version(require('./package.json').version)
	.arguments('<url>')
	.description('Simple tool for batch-downloading from Dynasty-Scans. Supports also PDF saving as well as chapter selection.')
	.option('-c, --chapters <a>-<b>', 'Chapter range.')
	.option('-C, --listChapters', 'List all chapters with correct indexes.')
	.option('-o, --output [path]', 'Different output path, defaults to current working directory.')
	.option('-p, --pdf', 'Downloads pdf instead of seperated images.')
	.option('-n, --noconvert', 'Skips PNG to PDF coversion.')
	.option('-v, --verbose', 'Includes progressbar for each GET request and PDF conversion.')
  .option('-r, --reDownloadChapter', 'Redownload all chapters included downloaded', undefined, false)
	.parse(process.argv)
if(!argv.args[0]) argv.help()

let config = {
	pdf: argv.pdf ? new pdfkit({autoFirstPage: false}) : false,
	output: path.resolve(argv.output || process.cwd()),
	verbose: argv.verbose,
}
let tempURL = new URL(argv.args[0])

//if(config.verbose) console.log('\n\tReceived:\t%s\n\tOutput type:\t%s\n\tImageEngine:\t%s', tempURL.origin + tempURL.pathname, config.pdf ? true : false, sharp ? 'sharp' : 'pngjs')

parseManga({
	url: tempURL.origin + tempURL.pathname,
	isSeries: !argv.args[0].includes('chapters'),
	chapters: argv.chapters
})

async function parseManga(manga) {
	let initialJSON = await get(manga.url + JSON_APPENDIX)
	let main = JSON.parse(initialJSON), name = main.name || main.long_title
  config.output = pj(config.output, 'mangas', legalize(name || ''));
  fs.ensureDirSync(config.output);
  console.log('\n    Download folder:', config.output);
	console.log('\n    Downloading:', name);
  // TODO: Make PDF chunks instead of single pdf. The name pdf should contain chapters ranges
	if(config.pdf) config.pdf.pipe(fs.createWriteStream( pj(config.output, `${name}.pdf`) ))
	if(manga.isSeries && (main.type == 'Series' || main.type == 'Anthology' || main.type == 'Author')){
		if(argv.listChapters){
			let hack = 0
			for(var i = 0; i < main.taggings.length; i++){
				let chapter = main.taggings[i]
				if (typeof (chapter.header) !== 'undefined'){
					if(chapter.header) console.log(' >> ', chapter.header) //ignore if is null
					hack++
				}else{
					console.log(`  ${i-hack}\t ${chapter.title}`)
				}
			}
			process.exit(0)
		}
		main.taggings = main.taggings.filter(key => typeof (key.header) === 'undefined')
		if(manga.chapters){
			let selection = manga.chapters.split('-')
			if(selection.length == 1)
				main.taggings = [ main.taggings[ selection[0] ] ]
			else if(selection.length == 2)
				main.taggings = main.taggings.slice(selection[0], parseInt(selection[1])+1)
		}
		for(var i = 0; i < main.taggings.length; i++){
			await getChapter(CHAPTER_PERMA + main.taggings[i].permalink + JSON_APPENDIX, main.taggings[i].title, false, i, main.taggings.length)
		}
	}else{
		await getChapter(main, main.long_title, true)
	}
	if(config.pdf) config.pdf.end()
	

	async function getChapter(input, chapterTitle, fetched = false, current = 0, length = 1){
		return new Promise(async resolve => {
			let chapter = fetched ? input : JSON.parse(await get(input)), pbar;
      const title = chapterTitle || chapter.long_title;
      const folderPath = pj(config.output, legalize(title));

			console.log('\t> (%d/%d) %s', current + 1, length, title);

      if (!config.reDownloadChapter && !checkDownloadedChapter(chapter, folderPath)) {
        console.log(`\tSkip downloading chapter ${title} because it's already downloaded`);
        return resolve();
      }

      if (!config.pdf) fs.ensureDirSync(folderPath);

      pbar = newProgress(chapter.pages.length) //doesnt really need to be verbosed, actually useful
			for(var y = 0; y < chapter.pages.length; y++){
				let imageURL = BASEURL+chapter.pages[y].url;
				if(config.pdf){
					await addPDFpage(imageURL, config.pdf)
				}else{
					await stream(imageURL, pj(
						folderPath,
						path.basename(imageURL)
					))
				}
				pbar.tick()
			}
			resolve()
		})
	}
}

function newProgress(total, extra = ''){ //cleaner, limits width
	return new progress('\t(:current/:total) [:bar] :percent ' + extra,{
		complete: '=',
		incomplete: '.',
		width: (total <= 20) ? total : 20,
		total: total
	})
}

function safeRequire(name){
	let found 
	try{ found = require(name) }catch(e){}
	return found
}

/* downloading pipelines */
function stream(url, output){
	return new Promise((resolve, reject) => {
		https.get(url, res => {
			res.pipe((typeof(output) == 'string') ? fs.createWriteStream(output) : output)
			res.on('end', () => resolve(res.statusCode) )
			res.on('error', reject)
		})
	})
}
function addPDFpage(url, document){
	return new Promise((resolve, reject) => {
		https.get(url, res => {
			let length = parseInt(res.headers['content-length']),
				lengthKnown = isNaN(length),
				pbar = config.verbose ? newProgress(lengthKnown ? 1 : length, `GET: ${url}`) : null
			let dim = null, buffer = []
			imageSize(res, (err,resolution) => {
				if(err) throw err
				dim = resolution
			})
			res.on('data', chunk => {
				buffer.push(chunk)
				if(pbar) pbar.tick(lengthKnown ? 0 : chunk.length)
			}).once('end', async () => {
				let image = Buffer.concat(buffer)
				if(dim.format == 'png' && !argv.noconvert) image = await convertImage(image)
				document.addPage({size: [dim.width, dim.height]})
				document.image(image, 0, 0)
				resolve()
			}).once('error', reject)
		})
	})
}
function convertImage(buffer){
	return new Promise((resolve, reject) => {
		//if sharp module is present, use it otherwise fallback to pngjs
		if(sharp){
			sharp(buffer).toBuffer().then(resolve).catch(reject)
		}else{
			let png = new PNG()
			png.parse(buffer, (err,data) => {
				if(err) return reject(err)
				let stream = png.pack()
				var cap = []
				stream.on('data', chunk => {cap.push(chunk)})
				stream.on('end', () => { resolve(Buffer.concat(cap)) })
			})
		}
	})
}
function get(url){
	return new Promise((resolve, reject) => {
		https.get(url, res => {
      console.log('\n'); // Need to new line
			let length = parseInt(res.headers['content-length']),
				lengthKnown = isNaN(length),
				pbar = config.verbose ? newProgress(lengthKnown ? 1 : length, `GET: ${url}`) : null
			let capture = ''
			res.on('data', chunk => {
				capture += chunk
				if(pbar) pbar.tick(lengthKnown ? 0 : chunk.length)
			}).once('end', () => {
				if(pbar && !lengthKnown) pbar.interrupt()
				resolve(capture)	//err.statusCode
			}).once('error', reject)
		})
	})
}

// some OS (eg. Windows) don't like them in the path name, so they throw a tantrum
function legalize(text = '', replacer = ''){
	return text.trim().replace(/\\|\/|:|\*|\?|"|<|>|'|,/g, replacer)
}

// TODO: Function that check if chapter donwloaded
// Downloaded will be load using fs.readdirSync
function checkDownloadedChapter(chapterInfo, folderPath) {
  try {
    const downloadedPages = fs.readdirSync(folderPath);

    // Don't Download when no pages for chapter
    if (!chapterInfo || !chapterInfo.pages || chapterInfo.pages.length <= 0) {
      return false;
    }

    // Download when no downloaded pages
    if (!downloadedPages || downloadedPages.length <= 0 || chapterInfo.pages.length !== downloadedPages.length) {
      return true;
    }

    return false;
  } catch (e) {
    // Return true so we download the chapter
    return true;
  }
}

// TODO: Try to save PDF but not work as expected
function savePDFFile(cb) {
  if (config.pdf && typeof config.pdf.end === "function") {
    config.pdf.end();
  }
}

function handleExit(signal = 0) {
  console.log('\nSIGNAL:', signal);
  savePDFFile();
  process.exit();
}

['exit', 'SIGINT', 'SIGUSR1', 'SIGUSR2', 'uncaughtException', 'SIGTERM'].forEach((eventType) => {
  process.on(eventType, handleExit);
})

// catches ctrl+c event
// process.on('SIGINT', (signal) => {
//   handleExit(signal);
// });

// process.on('SIGTERM', handleExit);

// catches "kill pid" (for example: nodemon restart)
// process.on('SIGUSR1', handleExit);
// process.on('SIGUSR2', handleExit);

// do something when app is closing
// process.on('exit', handleExit);
