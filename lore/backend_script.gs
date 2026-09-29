
/**
 * Lore Cloud Backend
 * Handles User Auth (Sheets), Book Storage (Drive), and Doc Export.
 */

const SCRIPT_PROP = PropertiesService.getScriptProperties();
const SHEET_NAME = "LoreUsers";
const PROP_SS_ID = "DB_SS_ID";

// Robustly get or create the database spreadsheet
function getDbSpreadsheet() {
  const id = SCRIPT_PROP.getProperty(PROP_SS_ID);
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch(e) {
      console.warn("Cached ID invalid, ignoring.");
    }
  }

  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) {
      SCRIPT_PROP.setProperty(PROP_SS_ID, active.getId());
      return active;
    }
  } catch(e) {}

  try {
    const newSS = SpreadsheetApp.create("Lore_App_Database");
    SCRIPT_PROP.setProperty(PROP_SS_ID, newSS.getId());
    return newSS;
  } catch(e) {
    throw new Error("Fatal: Could not create database spreadsheet. Check Drive permissions.");
  }
}

function setup() {
  const doc = getDbSpreadsheet();
  if (!doc) throw new Error("Database Spreadsheet is null");
  
  let sheet = doc.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = doc.insertSheet(SHEET_NAME);
    sheet.appendRow(["Created", "Username", "PasswordHash", "FolderID"]);
    sheet.getRange(1, 1, 1, 4).setFontWeight("bold");
  }
  return "Setup Complete. Database URL: " + doc.getUrl();
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(30000);

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return response({ status: "error", message: "No post data received" });
    }

    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    const doc = getDbSpreadsheet();

    if (action === "signup") return signUp(data, doc);
    if (action === "login") return login(data, doc);
    if (action === "syncUp") return saveProject(data);
    if (action === "syncDown") return loadProjects(data);
    if (action === "exportDoc") return exportToDoc(data);

    return response({ status: "error", message: "Invalid action: " + action });

  } catch (e) {
    return response({ status: "error", message: e.toString() });
  } finally {
    lock.releaseLock();
  }
}

// --- Auth Functions ---

function signUp(data, doc) {
  const { username, password } = data;
  if (!username || !password) throw new Error("Missing credentials");

  let sheet = doc.getSheetByName(SHEET_NAME);
  if (!sheet) {
     setup();
     sheet = doc.getSheetByName(SHEET_NAME);
  }

  const users = sheet.getDataRange().getValues();
  const exists = users.find(r => r[1] === username);
  if (exists) throw new Error("Username already taken");

  const folder = DriveApp.createFolder("Lore_Library_" + username);
  const folderId = folder.getId();

  const passHash = Utilities.base64Encode(password);
  sheet.appendRow([new Date(), username, passHash, folderId]);

  return response({ 
    status: "success", 
    username: username, 
    folderId: folderId,
    message: "Account created successfully"
  });
}

function login(data, doc) {
  const { username, password } = data;
  let sheet = doc.getSheetByName(SHEET_NAME);
  if (!sheet) {
     setup();
     sheet = doc.getSheetByName(SHEET_NAME);
  }
  
  const users = sheet.getDataRange().getValues();
  const passHash = Utilities.base64Encode(password);
  const user = users.find(r => r[1] === username && r[2] === passHash);

  if (!user) throw new Error("Invalid username or password");

  return response({ 
    status: "success", 
    username: user[1], 
    folderId: user[3] 
  });
}

// --- Drive Functions ---

function saveProject(data) {
  const { folderId, project } = data;
  if (!folderId || !project) throw new Error("Missing data");

  const folder = DriveApp.getFolderById(folderId);
  const fileName = `lore_backup_${project.id}.json`;

  // Check if file exists to update it, otherwise create new
  const files = folder.getFilesByName(fileName);
  if (files.hasNext()) {
    const file = files.next();
    file.setContent(JSON.stringify(project));
  } else {
    folder.createFile(fileName, JSON.stringify(project), "application/json");
  }

  return response({ status: "success", message: "Saved to Drive" });
}

function loadProjects(data) {
  const { folderId } = data;
  const folder = DriveApp.getFolderById(folderId);
  
  // Optimized search for specific backup files
  const files = folder.searchFiles("title contains 'lore_backup_' and trashed = false");
  const projects = [];

  while (files.hasNext()) {
    const file = files.next();
    try {
      const json = JSON.parse(file.getBlob().getDataAsString());
      // Ensure ID matches fallback if missing
      if (!json.id) json.id = file.getName().replace("lore_backup_", "").replace(".json", "");
      projects.push(json);
    } catch (e) {
      // Skip malformed files
    }
  }

  return response({ status: "success", projects: projects });
}

function exportToDoc(data) {
  const { folderId, title, description, chapters } = data;
  if (!folderId) throw new Error("Missing folder ID");
  
  const folder = DriveApp.getFolderById(folderId);
  const docName = title || "Untitled Manuscript";
  
  const doc = DocumentApp.create(docName);
  const file = DriveApp.getFileById(doc.getId());
  file.moveTo(folder);
  
  const body = doc.getBody();
  
  body.insertParagraph(0, docName).setHeading(DocumentApp.ParagraphHeading.TITLE);
  
  if (description) {
    body.appendParagraph(description).setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
  }
  
  body.appendPageBreak();
  
  if (chapters && Array.isArray(chapters)) {
    chapters.forEach(chap => {
      const chapTitle = (chap.chapterNumber === 0 ? "Introduction" : `Chapter ${chap.chapterNumber}`) + (chap.title ? `: ${chap.title}` : "");
      
      body.appendParagraph(chapTitle).setHeading(DocumentApp.ParagraphHeading.HEADING1);
      
      if (chap.content) {
        // Strip basic markdown symbols for cleaner doc
        const text = chap.content
          .replace(/#{1,6}\s/g, '') // Headers
          .replace(/\*\*/g, '')     // Bold
          .replace(/\*/g, '');      // Italic
        body.appendParagraph(text).setHeading(DocumentApp.ParagraphHeading.NORMAL);
      }
      body.appendPageBreak();
    });
  }
  
  doc.saveAndClose();
  return response({ status: "success", url: doc.getUrl(), message: "Google Doc Created" });
}

function response(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
