/**
 * Google Apps Script to generate a Google Doc from StoryForge JSON data.
 * 
 * INSTRUCTIONS:
 * 1. Create a new project at https://script.google.com/
 * 2. Paste this code into Code.gs
 * 3. Click "Deploy" -> "New deployment"
 * 4. Select type: "Web app"
 * 5. Description: "StoryForge API"
 * 6. Execute as: "Me"
 * 7. Who has access: "Anyone" (Important for the web app to reach it without OAuth complexity)
 * 8. Click "Deploy"
 * 9. Copy the "Web app URL" and paste it into the StoryForge app when prompted.
 */

function doPost(e) {
  // CORS Helper: Handle preflight or ensure we return JSON properly
  // Note: Simple triggers don't handle OPTIONS, but the web app simply receives POST.
  
  try {
    // Parse the incoming JSON body
    // Apps Script receives POST data in e.postData.contents
    var requestData = JSON.parse(e.postData.contents);
    
    // Create the document
    var docTitle = requestData.title || "Untitled StoryForge Manuscript";
    var doc = DocumentApp.create(docTitle);
    var body = doc.getBody();
    
    // -- Formatting --
    
    // Title
    body.insertParagraph(0, docTitle)
        .setHeading(DocumentApp.ParagraphHeading.TITLE);
    
    // Description/Synopsis
    if (requestData.description) {
      body.appendParagraph(requestData.description)
          .setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
    }
    
    body.appendPageBreak();
    
    // Process Chapters
    if (requestData.chapters && Array.isArray(requestData.chapters)) {
      requestData.chapters.forEach(function(chapter) {
        // Chapter Title
        var titleText = "Chapter " + chapter.chapterNumber + ": " + (chapter.title || "Untitled");
        body.appendParagraph(titleText)
            .setHeading(DocumentApp.ParagraphHeading.HEADING1);
        
        // Chapter Content
        if (chapter.content) {
          // Basic cleanup: Remove markdown bold/italic markers if desired, 
          // or ideally, use a markdown parser. 
          // For this simple script, we strip some common MD chars to keep it clean.
          var cleanContent = chapter.content
            .replace(/^#+\s/gm, '') // Remove headers
            .replace(/\*\*/g, '')   // Remove bold
            .replace(/\*/g, '')     // Remove italic
            .replace(/`/g, '');     // Remove code ticks
            
          body.appendParagraph(cleanContent)
              .setHeading(DocumentApp.ParagraphHeading.NORMAL);
        } else {
          body.appendParagraph("[Chapter content not generated yet]")
              .setHeading(DocumentApp.ParagraphHeading.NORMAL)
              .setItalic(true);
        }
        
        body.appendPageBreak();
      });
    }
    
    // Save and get URL
    doc.saveAndClose();
    var url = doc.getUrl();
    
    // Return Success JSON
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      url: url,
      message: "Document created successfully"
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    // Return Error JSON
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Handle GET requests just to confirm the app is running.
 */
function doGet(e) {
  return ContentService.createTextOutput("StoryForge Docs API is running. Send a POST request to create a document.");
}