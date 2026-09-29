import JSZip from 'jszip';
import { ChapterContent } from '../types';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function markdownToXhtmlParagraphs(markdown: string): string {
  if (!markdown) return '<p></p>';
  
  const lines = markdown.split('\n');
  const htmlBlocks: string[] = [];
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      let text = currentParagraph.join(' ').trim();
      if (text) {
        // Simple inline formatting
        text = text
          .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/_(.*?)_/g, '<em>$1</em>');
        htmlBlocks.push(`<p>${escapeXml(text).replace(/&lt;strong&gt;/g, '<strong>').replace(/&lt;\/strong&gt;/g, '</strong>').replace(/&lt;em&gt;/g, '<em>').replace(/&lt;\/em&gt;/g, '</em>')}</p>`);
      }
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith('# ')) {
      flushParagraph();
      htmlBlocks.push(`<h1>${escapeXml(trimmed.replace(/^#\s+/, ''))}</h1>`);
    } else if (trimmed.startsWith('## ')) {
      flushParagraph();
      htmlBlocks.push(`<h2>${escapeXml(trimmed.replace(/^##\s+/, ''))}</h2>`);
    } else if (trimmed.startsWith('### ')) {
      flushParagraph();
      htmlBlocks.push(`<h3>${escapeXml(trimmed.replace(/^###\s+/, ''))}</h3>`);
    } else if (trimmed === '***' || trimmed === '---' || trimmed === '___') {
      flushParagraph();
      htmlBlocks.push('<hr class="scene-break" />');
    } else {
      currentParagraph.push(trimmed);
    }
  }

  flushParagraph();
  return htmlBlocks.join('\n');
}

export const generateEpub = async (
  title: string,
  description: string,
  chapters: ChapterContent[],
  coverImageBase64?: string
): Promise<Blob> => {
  const zip = new JSZip();

  // 1. mimetype MUST be uncompressed first entry
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // 2. META-INF/container.xml
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // 3. Stylesheet
  const css = `
body {
  font-family: "Georgia", "Merriweather", serif;
  line-height: 1.6;
  margin: 5%;
  color: #111;
}
h1, h2, h3 {
  font-family: "Helvetica Neue", "Arial", sans-serif;
  text-align: center;
  margin-top: 1.5em;
  margin-bottom: 0.8em;
  font-weight: bold;
}
h1.title {
  font-size: 2.2em;
  margin-top: 2em;
}
.subtitle {
  font-style: italic;
  text-align: center;
  color: #555;
  margin-bottom: 3em;
}
p {
  text-indent: 1.5em;
  margin-top: 0;
  margin-bottom: 0.2em;
  text-align: justify;
}
.chapter-num {
  font-family: sans-serif;
  text-transform: uppercase;
  letter-spacing: 2px;
  font-size: 0.8em;
  color: #666;
  text-align: center;
  margin-top: 3em;
}
.scene-break {
  border: 0;
  text-align: center;
  margin: 2em 0;
}
.scene-break:after {
  content: "✦ ✦ ✦";
  color: #888;
}
img.cover {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}
`;
  zip.file('OEBPS/styles.css', css);

  let hasCover = false;
  if (coverImageBase64) {
    try {
      // Decode base64 to binary
      const binaryImg = atob(coverImageBase64);
      const imgBytes = new Uint8Array(binaryImg.length);
      for (let i = 0; i < binaryImg.length; i++) {
        imgBytes[i] = binaryImg.charCodeAt(i);
      }
      zip.file('OEBPS/images/cover.jpg', imgBytes);
      hasCover = true;
    } catch (e) {
      console.error('Failed to encode EPUB cover image:', e);
    }
  }

  // 4. Build Title Page
  const titlePageXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
  <title>${escapeXml(title)}</title>
  <link rel="stylesheet" href="styles.css" type="text/css"/>
</head>
<body>
  ${hasCover ? '<div style="text-align:center;"><img class="cover" src="images/cover.jpg" alt="Cover"/></div>' : ''}
  <h1 class="title">${escapeXml(title)}</h1>
  <p class="subtitle">${escapeXml(description)}</p>
</body>
</html>`;
  zip.file('OEBPS/titlepage.xhtml', titlePageXhtml);

  // 5. Build Chapter XHTML files
  const manifestItems: string[] = [
    `<item id="styles" href="styles.css" media-type="text/css"/>`,
    `<item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>`,
    `<item id="toc" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
  ];

  if (hasCover) {
    manifestItems.push(`<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>`);
  }

  const spineItems: string[] = [
    `<itemref idref="titlepage"/>`,
    `<itemref idref="toc"/>`
  ];

  const tocList: string[] = [];
  const ncxNavPoints: string[] = [];

  chapters.forEach((chap, idx) => {
    const chapterId = `chapter_${chap.chapterNumber}`;
    const chapterFilename = `${chapterId}.xhtml`;
    const label = chap.chapterNumber === 0 ? 'Introduction' : `Chapter ${chap.chapterNumber}`;
    const chapterTitle = chap.title || label;

    const bodyContent = markdownToXhtmlParagraphs(chap.content);
    
    let imageXhtml = '';
    if (chap.image) {
      try {
        const imgBin = atob(chap.image);
        const imgBytes = new Uint8Array(imgBin.length);
        for (let i = 0; i < imgBin.length; i++) imgBytes[i] = imgBin.charCodeAt(i);
        const imgPath = `images/chap_${chap.chapterNumber}.jpg`;
        zip.file(`OEBPS/${imgPath}`, imgBytes);
        const imgItemId = `chap_img_${chap.chapterNumber}`;
        manifestItems.push(`<item id="${imgItemId}" href="${imgPath}" media-type="image/jpeg"/>`);
        imageXhtml = `<div style="text-align:center; margin:1.5em 0;"><img src="${imgPath}" alt="${escapeXml(chapterTitle)}" style="max-width:100%; border-radius:4px;"/></div>`;
      } catch (e) {
        console.error('Failed to attach chapter image in EPUB:', e);
      }
    }

    const chapterXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
  <title>${escapeXml(chapterTitle)}</title>
  <link rel="stylesheet" href="styles.css" type="text/css"/>
</head>
<body>
  <div class="chapter-num">${escapeXml(label)}</div>
  <h2>${escapeXml(chapterTitle)}</h2>
  ${imageXhtml}
  ${bodyContent}
</body>
</html>`;

    zip.file(`OEBPS/${chapterFilename}`, chapterXhtml);

    manifestItems.push(`<item id="${chapterId}" href="${chapterFilename}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${chapterId}"/>`);

    tocList.push(`<li><a href="${chapterFilename}">${escapeXml(label)}: ${escapeXml(chapterTitle)}</a></li>`);
    ncxNavPoints.push(`
    <navPoint id="nav_${chapterId}" playOrder="${idx + 2}">
      <navLabel><text>${escapeXml(label)}: ${escapeXml(chapterTitle)}</text></navLabel>
      <content src="${chapterFilename}"/>
    </navPoint>`);
  });

  // 6. TOC XHTML
  const tocXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
  <title>Table of Contents</title>
  <link rel="stylesheet" href="styles.css" type="text/css"/>
</head>
<body>
  <h2>Table of Contents</h2>
  <nav epub:type="toc">
    <ol style="list-style-type: none; padding-left:0; text-align:center; line-height:2em;">
      ${tocList.join('\n')}
    </ol>
  </nav>
</body>
</html>`;
  zip.file('OEBPS/toc.xhtml', tocXhtml);

  // 7. TOC NCX
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:lore-${Date.now()}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    <navPoint id="nav_titlepage" playOrder="1">
      <navLabel><text>Title Page</text></navLabel>
      <content src="titlepage.xhtml"/>
    </navPoint>
    ${ncxNavPoints.join('\n')}
  </navMap>
</ncx>`;
  zip.file('OEBPS/toc.ncx', ncx);

  // 8. content.opf
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId">urn:uuid:lore-${Date.now()}</dc:identifier>
    <dc:description>${escapeXml(description)}</dc:description>
    <dc:creator>Lore AI</dc:creator>
    ${hasCover ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`;
  zip.file('OEBPS/content.opf', opf);

  return await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
};
