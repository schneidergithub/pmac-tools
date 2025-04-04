/**
 * PMAC to Jira Importer
 * 
 * Creates a Jira project and imports PMAC user stories and epics using Jira REST API v3.
 * Designed to handle various Jira configurations and establish parent-child relationships.
 */

const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// Configuration
const config = {
  jiraHost: process.env.JIRA_HOST,
  jiraEmail: process.env.JIRA_EMAIL,
  jiraApiToken: process.env.JIRA_API_TOKEN,
  projectKey: process.env.PROJECT_KEY || 'PMAC',
  projectName: process.env.PROJECT_NAME || 'Project Management as Code'
};

// Jira API client
const jiraClient = axios.create({
  baseURL: `${config.jiraHost}/rest/api/3`,
  auth: {
    username: config.jiraEmail,
    password: config.jiraApiToken
  },
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

// Load PMAC stories data
function loadPmacData() {
  try {
    const storiesFile = './pmac-jira-import-json.json';
    return JSON.parse(fs.readFileSync(storiesFile, 'utf8'));
  } catch (error) {
    console.error('Failed to load PMAC data:', error.message);
    throw new Error('Unable to load PMAC data file. Please ensure pmac-jira-import-json.json exists.');
  }
}

// Track created epics for linking stories
const epicMap = new Map();

/**
 * Creates a new Jira project or uses an existing one with the same key
 */
async function createProject() {
  // Generate a unique name with today's date
  const uniqueProjectName = `${config.projectName} ${new Date().toISOString().slice(0, 10)}`;
  console.log(`Creating project: ${uniqueProjectName} (${config.projectKey})`);
  
  try {
    // First check if project already exists
    try {
      const existing = await jiraClient.get(`/project/${config.projectKey}`);
      console.log(`Project ${config.projectKey} already exists, using it`);
      return existing.data;
    } catch (error) {
      // 404 means project doesn't exist, which is what we want to continue
      if (error.response?.status !== 404) throw error;
    }
    
    // Get current user information for project lead
    const myself = await jiraClient.get('/myself');
    console.log(`Using current user as project lead: ${myself.data.displayName}`);
    const leadAccountId = myself.data.accountId;
    
    // Get available project type keys
    const projectTypes = await jiraClient.get('/project/type');
    console.log('Available project types:', projectTypes.data.map(t => t.key));
    const softwareType = projectTypes.data.find(t => t.key === 'software') || projectTypes.data[0];
    
    // Create project with required data
    const projectData = {
      key: config.projectKey,
      name: uniqueProjectName,
      projectTypeKey: softwareType.key,
      description: 'PMAC imported project',
      leadAccountId: leadAccountId // Required field
    };

    console.log('Creating project with:', JSON.stringify(projectData, null, 2));
    const response = await jiraClient.post('/project', projectData);
    
    console.log(`Project created successfully: ${response.data.key}`);
    return response.data;
  } catch (error) {
    console.error('Error creating project:', error.message);
    
    if (error.response?.data) {
      console.error('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    throw new Error(`Failed to create project: ${error.message}`);
  }
}

/**
 * Analyzes available issue types in the Jira project
 */
async function getIssueTypes(projectKey) {
  try {
    // Get available issue types for this project
    const meta = await jiraClient.get(`/issue/createmeta?projectKeys=${projectKey}&expand=projects.issuetypes.fields`);
    const projectMeta = meta.data.projects[0];
    
    if (!projectMeta || !projectMeta.issuetypes || projectMeta.issuetypes.length === 0) {
      throw new Error('No issue types found for this project');
    }
    
    const issueTypes = projectMeta.issuetypes;
    console.log('Available issue types:', issueTypes.map(t => t.name).join(', '));
    
    // Find the best types to use for epics, stories, and subtasks
    const epicType = issueTypes.find(t => t.name === 'Epic') || 
                    issueTypes.find(t => t.name.includes('Epic')) ||
                    issueTypes.find(t => t.name === 'Task') ||
                    issueTypes[0];
    
    const storyType = issueTypes.find(t => t.name === 'Story') || 
                    issueTypes.find(t => t.name.includes('Story')) ||
                    issueTypes.find(t => t.name === 'Task' && !t.subtask) ||
                    issueTypes.find(t => !t.subtask) ||
                    issueTypes[0];
    
    const subtaskType = issueTypes.find(t => t.name === 'Sub-task') ||
                      issueTypes.find(t => t.name.includes('Subtask')) ||
                      issueTypes.find(t => t.subtask === true) ||
                      null;
    
    // Check if they support parent-child relationships
    let hierarchySupported = false;
    if (subtaskType) {
      // Fetch the subtask metadata to see if it supports parent field
      try {
        const subtaskMeta = await jiraClient.get(`/issue/createmeta?projectKeys=${projectKey}&issuetypeIds=${subtaskType.id}&expand=projects.issuetypes.fields`);
        const fields = subtaskMeta.data.projects[0]?.issuetypes[0]?.fields || {};
        hierarchySupported = Boolean(fields.parent);
        
        if (hierarchySupported) {
          console.log(`Hierarchy supported: Sub-tasks can have parents`);
        }
      } catch (e) {
        console.log(`Could not determine if hierarchy is supported: ${e.message}`);
      }
    }
    
    return {
      epicType,
      storyType,
      subtaskType,
      hierarchySupported,
      all: issueTypes
    };
  } catch (error) {
    console.error('Error analyzing issue types:', error.message);
    throw error;
  }
}

/**
 * Creates components from story/epic components
 */
async function createComponents(projectKey, components) {
  const componentNames = [...new Set(components)];
  
  if (componentNames.length === 0) return [];
  
  console.log(`Creating ${componentNames.length} components`);
  const createdComponents = [];
  
  for (const name of componentNames) {
    try {
      const response = await jiraClient.post('/component', {
        name,
        project: projectKey,
        description: `PMAC ${name} component`
      });
      createdComponents.push(response.data);
      console.log(`Created component: ${name}`);
    } catch (error) {
      // Skip if component already exists
      console.warn(`Couldn't create component ${name}: ${error.message}`);
    }
    
    // Small delay to avoid rate limiting
    await delay(100);
  }
  
  return createdComponents;
}

/**
 * Creates an epic in Jira
 */
async function createEpic(epic, projectKey, issueTypes) {
  console.log(`Creating epic: ${epic.summary}`);
  
  try {
    // Use the recommended issue type for epics
    const epicIssueType = issueTypes.epicType;
    console.log(`Using issue type: ${epicIssueType.name} for epics`);
    
    // Basic issue data with only required fields
    const epicData = {
      fields: {
        project: {
          key: projectKey
        },
        summary: epic.summary,
        issuetype: {
          id: epicIssueType.id
        }
      }
    };
    
    const response = await jiraClient.post('/issue', epicData);
    console.log(`Epic created: ${response.data.key}`);
    
    // Save mapping for story linking
    epicMap.set(epic.summary, response.data.key);
    
    // Try to update the description using our specialized ADF function
    if (epic.description) {
      const updateResult = await updateDescriptionWithADF(response.data.key, epic.description);
      if (updateResult.success) {
        console.log(`Successfully added description using ${updateResult.format} format`);
      }
    }
    
    return response.data;
  } catch (error) {
    console.error(`Error creating epic "${epic.summary}":`, error.message);
    
    if (error.response?.data) {
      console.error('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    // Try again with minimal fields
    try {
      console.log('Retrying with minimal fields...');
      const minimalData = {
        fields: {
          project: { key: projectKey },
          summary: epic.summary,
          issuetype: { name: 'Task' }
        }
      };
      
      const retryResponse = await jiraClient.post('/issue', minimalData);
      console.log(`Epic created with minimal fields: ${retryResponse.data.key}`);
      
      // Save mapping for story linking
      epicMap.set(epic.summary, retryResponse.data.key);
      return retryResponse.data;
    } catch (retryError) {
      console.error('Retry also failed:', retryError.message);
      return null;
    }
  }
}

/**
 * Creates a story in Jira, optionally as a subtask of an epic
 */
async function createStory(story, projectKey, issueTypes, parentEpicKey) {
  console.log(`Creating story: ${story.summary}`);
  
  // Check if we can create a sub-task directly linked to parent
  if (issueTypes.hierarchySupported && parentEpicKey && issueTypes.subtaskType) {
    try {
      console.log(`Attempting to create as a sub-task of ${parentEpicKey}...`);
      
      const storyData = {
        fields: {
          project: {
            key: projectKey
          },
          summary: story.summary,
          issuetype: {
            id: issueTypes.subtaskType.id
          },
          parent: {
            key: parentEpicKey
          }
        }
      };
      
      const response = await jiraClient.post('/issue', storyData);
      console.log(`Story created as sub-task: ${response.data.key}`);
      
      // Try to update the description
      if (story.description) {
        const updateResult = await updateDescriptionWithADF(response.data.key, story.description);
        if (updateResult.success) {
          console.log(`Successfully added description using ${updateResult.format} format`);
        }
      }
      
      return response.data;
    } catch (error) {
      console.error(`Could not create as sub-task: ${error.message}`);
      // Fall through to regular story creation
    }
  }
  
  // Regular story creation
  try {
    // Use the recommended issue type for stories
    const storyIssueType = issueTypes.storyType;
    console.log(`Using issue type: ${storyIssueType.name} for stories`);
    
    // Basic issue data
    const storyData = {
      fields: {
        project: {
          key: projectKey
        },
        summary: story.summary,
        issuetype: {
          id: storyIssueType.id
        }
      }
    };
    
    // Make the API call to create the issue
    const response = await jiraClient.post('/issue', storyData);
    console.log(`Story created: ${response.data.key}`);
    
    // Try to update the description
    if (story.description) {
      const updateResult = await updateDescriptionWithADF(response.data.key, story.description);
      if (updateResult.success) {
        console.log(`Successfully added description using ${updateResult.format} format`);
      }
    }
    
    return response.data;
  } catch (error) {
    console.error(`Error creating story "${story.summary}":`, error.message);
    
    if (error.response?.data) {
      console.error('Error details:', JSON.stringify(error.response.data, null, 2));
    }
    
    try {
      console.log('Retrying with absolute minimal fields...');
      // Most minimal possible payload
      const minimalData = {
        fields: {
          project: {
            key: projectKey
          },
          summary: story.summary,
          issuetype: {
            name: 'Task'  // Most basic issue type
          }
        }
      };
      
      const retryResponse = await jiraClient.post('/issue', minimalData);
      console.log(`Story created with minimal fields: ${retryResponse.data.key}`);
      return retryResponse.data;
    } catch (retryError) {
      console.error('Final attempt failed:', retryError.message);
      return null;
    }
  }
}

/**
 * Attempts to link a story to its parent epic using different methods
 */
async function linkStoryToEpic(storyKey, epicKey) {
  console.log(`Attempting to link story ${storyKey} to epic ${epicKey}...`);
  
  // Different approaches to try for linking
  const approaches = [
    // Approach 1: Creating a sub-task relationship
    {
      name: "convert-to-subtask",
      execute: async () => {
        // Get available issue types
        const meta = await jiraClient.get(`/issue/createmeta?projectKeys=${config.projectKey}&expand=projects.issuetypes`);
        const projectMeta = meta.data.projects[0];
        
        // Find a Sub-task issue type
        const subTaskType = projectMeta.issuetypes.find(t => 
          t.name === 'Sub-task' || 
          t.name.includes('Subtask') ||
          t.subtask === true
        );
        
        if (!subTaskType) {
          throw new Error("No Sub-task issue type found");
        }
        
        console.log(`Found Sub-task type: ${subTaskType.name} (${subTaskType.id})`);
        
        // Attempt to update the issue type to Sub-task and set parent
        await jiraClient.put(`/issue/${storyKey}`, {
          fields: {
            issuetype: { id: subTaskType.id },
            parent: { key: epicKey }
          }
        });
      }
    },
    
    // Approach 2: Using issue linking (standard relates)
    {
      name: "issue-link-relates",
      execute: async () => {
        await jiraClient.post('/issueLink', {
          type: { name: "Relates" },
          inwardIssue: { key: storyKey },
          outwardIssue: { key: epicKey }
        });
      }
    },
    
    // Approach 3: Using issue linking with different relationship types
    {
      name: "issue-link-blocks",
      execute: async () => {
        await jiraClient.post('/issueLink', {
          type: { name: "Blocks" },
          inwardIssue: { key: epicKey },
          outwardIssue: { key: storyKey }
        });
      }
    },
    
    // Approach 4: Using Epic Link custom field directly if it exists
    {
      name: "epic-link-customfield",
      execute: async () => {
        // Find all custom fields
        const fields = await jiraClient.get('/field');
        const epicLinkField = fields.data.find(f => 
          f.name === 'Epic Link' || 
          f.name.includes('Epic') || 
          f.schema?.custom?.includes('epic')
        );
        
        if (!epicLinkField) {
          throw new Error("Epic Link field not found");
        }
        
        console.log(`Found Epic Link field: ${epicLinkField.id}`);
        
        // Update using the custom field
        const updateData = {
          fields: {}
        };
        updateData.fields[epicLinkField.id] = epicKey;
        
        await jiraClient.put(`/issue/${storyKey}`, updateData);
      }
    },
    
    // Approach 5: Recreate as a sub-task if update fails
    {
      name: "recreate-as-subtask",
      execute: async () => {
        // Get the current story details
        const storyResp = await jiraClient.get(`/issue/${storyKey}`);
        const storyData = storyResp.data;
        
        // Find a Sub-task issue type
        const meta = await jiraClient.get(`/issue/createmeta?projectKeys=${config.projectKey}&expand=projects.issuetypes`);
        const projectMeta = meta.data.projects[0];
        const subTaskType = projectMeta.issuetypes.find(t => 
          t.name === 'Sub-task' || 
          t.name.includes('Subtask') ||
          t.subtask === true
        );
        
        if (!subTaskType) {
          throw new Error("No Sub-task issue type found");
        }
        
        // Create a new sub-task with the same details
        const newIssue = await jiraClient.post('/issue', {
          fields: {
            project: { key: config.projectKey },
            summary: storyData.fields.summary,
            issuetype: { id: subTaskType.id },
            parent: { key: epicKey },
            description: storyData.fields.description
          }
        });
        
        console.log(`Created new sub-task ${newIssue.data.key} from ${storyKey}`);
        
        // Optional: add a link to the original issue
        await jiraClient.post('/issueLink', {
          type: { name: "Relates" },
          inwardIssue: { key: newIssue.data.key },
          outwardIssue: { key: storyKey }
        });
        
        return newIssue.data.key; // Return the new key to update the mapping
      }
    },
    
    // Approach 6: Add a label to make them visually connected
    {
      name: "add-epic-label",
      execute: async () => {
        // Get the epic's summary to use as label
        const epicResp = await jiraClient.get(`/issue/${epicKey}`);
        const epicSummary = epicResp.data.fields.summary;
        
        // Create a label from epic summary (alphanum only)
        const epicLabel = `Epic_${epicKey.replace(/-/g, '_')}`;
        
        await jiraClient.put(`/issue/${storyKey}`, {
          update: {
            labels: [{ add: epicLabel }]
          }
        });
      }
    }
  ];
  
  // Try each approach
  for (const approach of approaches) {
    try {
      console.log(`Trying ${approach.name} approach...`);
      const result = await approach.execute();
      console.log(`Success! ${approach.name} approach worked.`);
      
      return {
        success: true,
        approach: approach.name,
        newKey: result // In case we created a new issue
      };
    } catch (error) {
      console.log(`${approach.name} approach failed: ${error.message}`);
      if (error.response?.data) {
        console.log(`Error details: ${JSON.stringify(error.response.data, null, 2)}`);
      }
    }
  }
  
  // If we get here, all attempts failed
  console.log(`All approaches to link story ${storyKey} to epic ${epicKey} failed`);
  return {
    success: false
  };
}

/**
 * Helper function to try different Atlassian Document Format approaches
 */
async function updateDescriptionWithADF(issueKey, description) {
  console.log(`Attempting to update description for ${issueKey} with ADF format...`);
  
  // Different ADF formats to try
  const formatOptions = [
    // Option 1: Update API with set operation (recommended approach)
    {
      name: "update-set-operation",
      payload: {
        update: {
          description: [
            {
              set: {
                type: "doc",
                version: 1,
                content: [
                  {
                    type: "paragraph",
                    content: [
                      {
                        type: "text",
                        text: description
                      }
                    ]
                  }
                ]
              }
            }
          ]
        }
      }
    },
    
    // Option 2: Direct field update with ADF
    {
      name: "direct-field-update",
      payload: {
        fields: {
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: description
                  }
                ]
              }
            ]
          }
        }
      }
    },
    
    // Option 3: Split into multiple paragraphs
    {
      name: "multi-paragraph",
      payload: {
        fields: {
          description: {
            type: "doc",
            version: 1,
            content: description.split("\n\n").map(para => ({
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: para
                }
              ]
            }))
          }
        }
      }
    },
    
    // Option 4: Simple plain text (some Jira instances accept this)
    {
      name: "plain-text",
      payload: {
        fields: {
          description: description
        }
      }
    }
  ];
  
  // Try each format option
  for (const option of formatOptions) {
    try {
      console.log(`Trying ${option.name} format...`);
      await jiraClient.put(`/issue/${issueKey}`, option.payload);
      console.log(`Success! ${option.name} format worked.`);
      return {
        success: true,
        format: option.name
      };
    } catch (error) {
      console.log(`${option.name} format failed: ${error.message}`);
      if (error.response?.data) {
        console.log(`Error details: ${JSON.stringify(error.response.data, null, 2)}`);
      }
    }
    
    // Small delay between attempts
    await delay(200);
  }
  
  // If we get here, all attempts failed
  console.log(`All description update attempts failed for ${issueKey}`);
  return {
    success: false
  };
}

/**
 * Helper function to delay execution
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Main import function
 */
async function importToJira() {
  try {
    console.log('PMAC to Jira Import Starting');
    console.log(`Jira Host: ${config.jiraHost}`);
    console.log(`Project: ${config.projectKey}`);
    
    // Load PMAC data
    const { epics, stories } = loadPmacData();
    
    // 1. Create project
    const project = await createProject();
    
    // 2. Get issue types to use
    console.log('\n=== Analyzing Issue Types ===');
    const issueTypes = await getIssueTypes(project.key);
    console.log(`Will use ${issueTypes.epicType.name} for epics, ${issueTypes.storyType.name} for stories` + 
                (issueTypes.subtaskType ? `, and ${issueTypes.subtaskType.name} for subtasks` : ''));
    
    // 3. Extract unique components
    const componentNames = [...new Set([
      ...epics.map(e => e.component).filter(Boolean),
      ...stories.map(s => s.component).filter(Boolean)
    ])];
    
    // 4. Create components if any exist
    if (componentNames.length > 0) {
      try {
        await createComponents(project.key, componentNames);
      } catch (error) {
        console.warn('Component creation failed, continuing without components:', error.message);
      }
    } else {
      console.log('No components to create');
    }
    
    // 5. Create all epics
    console.log('\n=== Creating Epics ===');
    const createdEpics = [];
    for (const epic of epics) {
      const result = await createEpic(epic, project.key, issueTypes);
      if (result) createdEpics.push(result);
      await delay(300); // Avoid rate limiting
    }
    
    // 6. Create all stories with parent links where possible
    console.log('\n=== Creating Stories ===');
    const createdStories = [];
    
    for (const story of stories) {
      // Try to find parent epic key if available
      let parentEpicKey = null;
      if (story.epicLink && epicMap.has(story.epicLink)) {
        parentEpicKey = epicMap.get(story.epicLink);
      }
      
      const response = await createStory(story, project.key, issueTypes, parentEpicKey);
      
      if (response) {
        createdStories.push({
          key: response.key || response.id,
          epicLink: story.epicLink,
          linkedAsSubtask: Boolean(parentEpicKey && issueTypes.hierarchySupported)
        });
      }
      
      await delay(300); // Avoid rate limiting
    }
    
    // 7. Link any remaining stories to epics that weren't created as subtasks
    const storiesNeedingLinks = createdStories.filter(s => !s.linkedAsSubtask && s.epicLink);
    
    if (storiesNeedingLinks.length > 0) {
      console.log(`\n=== Linking ${storiesNeedingLinks.length} Stories to Epics ===`);
      
      for (const story of storiesNeedingLinks) {
        if (story.epicLink && epicMap.has(story.epicLink)) {
          const epicKey = epicMap.get(story.epicLink);
          
          // Try to link the story to its epic
          const linkResult = await linkStoryToEpic(story.key, epicKey);
          
          // If the linking method created a new issue (like recreate-as-subtask),
          // we need to update our mapping
          if (linkResult.success && linkResult.newKey) {
            console.log(`Story ${story.key} was recreated as sub-task ${linkResult.newKey}`);
          }
          
          await delay(300); // Avoid rate limiting
        }
      }
    } else {
      console.log('\n=== All stories already linked as subtasks ===');
    }
    
    // 8. Print summary
    console.log('\n✅ Import completed successfully!');
    console.log(`View your project at: ${config.jiraHost}/projects/${project.key}`);
    
    console.log('\n=== Import Summary ===');
    console.log(`Created ${createdEpics.length} epics using ${issueTypes.epicType.name} issue type`);
    console.log(`Created ${createdStories.length} stories`);
    console.log(`- ${createdStories.filter(s => s.linkedAsSubtask).length} created as subtasks`);
    console.log(`- ${storiesNeedingLinks.length} linked using alternate methods`);
    
    return {
      success: true,
      projectKey: project.key,
      epicsCreated: createdEpics.length,
      storiesCreated: createdStories.length
    };
  } catch (error) {
    console.error('Import failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    return {
      success: false,
      error: error.message
    };
  }
}

// If this file is run directly (not imported), execute the import
if (require.main === module) {
  importToJira().then(result => {
    if (!result.success) {
      process.exit(1);
    }
  });
}

// Export functions for testing or programmatic use
module.exports = {
  importToJira,
  createProject,
  getIssueTypes,
  createComponents,
  createEpic,
  createStory,
  linkStoryToEpic,
  updateDescriptionWithADF
};