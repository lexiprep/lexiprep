import JSZip from "jszip";

/**
 * Build a minimal valid single-chapter EPUB in memory (Buffer) for processBook tests.
 * `extraFiles` (path -> contents) is merged in, for cases like a `META-INF/encryption.xml`
 * sidecar.
 */
export async function makeEpub(
  body: string,
  title = "Test Book",
  extraFiles: Record<string, string> = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.file(
    "OEBPS/ch1.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body>${body}</body></html>`,
  );
  zip.file(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head/><docTitle><text>${title}</text></docTitle>
  <navMap><navPoint id="np0" playOrder="1"><navLabel><text>One</text></navLabel>
    <content src="ch1.xhtml"/></navPoint></navMap>
</ncx>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
    <dc:identifier id="bookid">urn:uuid:test-0001</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch0" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="ch0"/></spine>
</package>`,
  );
  for (const [path, contents] of Object.entries(extraFiles)) zip.file(path, contents);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** An `encryption.xml` declaring `algorithm` over one resource. */
export function encryptionXml(algorithm: string, uri = "OEBPS/ch1.xhtml"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <EncryptionMethod Algorithm="${algorithm}"/>
    <CipherData><CipherReference URI="${uri}"/></CipherData>
  </EncryptedData>
</encryption>`;
}
