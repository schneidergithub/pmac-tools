# Importing PMAC User Stories to Jira

This guide explains how to automatically create a Jira project with all your PMAC user stories using the Jira REST API.

## Overview

The solution includes:

1. A structured JSON file containing all epics and user stories
2. A Node.js script that uses the Jira REST API to create:
   - A new project in Jira with user stories linked to their respective epics based on the JSON file.  Bonus points for hooking to git!

## Prerequisites

- Node.js installed (version 14+ recommended)
- A Jira Cloud instance with admin access
- Jira API token (generated from [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens))

## Setup Instructions

1. **Install required npm packages**:

```bash
npm install axios dotenv
```

2. **Create a `.env` file** using the `.env.example` template:

```bash
cp .env.example .env
```

3. **Edit the `.env` file** with your Jira details:
   - `JIRA_HOST`: Your Jira instance URL (e.g., https://your-company.atlassian.net)
   - `JIRA_EMAIL`: Your Atlassian account email
   - `JIRA_API_TOKEN`: Your API token generated from Atlassian account
   - `PROJECT_KEY`: The key for your project (default: PMAC)
   - `LEAD_ACCOUNT_ID`: (Optional) The account ID of the project lead

4. **Review the JSON data**:
   - Check the epics and stories in `pmac-jira-import-json.json`
   - Modify priorities, components, or labels as needed

## Running the Import

Execute the script to create the project and import all user stories:

```bash
node jira-import-script.js
```

The script will:
1. Create the PMAC project if it doesn't exist
2. Create components (Core, Integration, Security)
3. Create all epics first
4. Create user stories and link them to their respective epics

## Troubleshooting

### Common Issues:

- **Authentication Error**: Check your API token and ensure it's correctly entered in the `.env` file
- **Permission Error**: Make sure your account has project creation permissions in Jira
- **Rate Limiting**: If you encounter rate limits, the script may need to be modified to add delays

### Checking Logs:
The script logs each operation to the console, which can help identify where issues occur.

## Customization

You can customize the import process by:

- Editing the project template type in `createProject()` function
- Adding additional fields to stories or epics
- Modifying the project description
- Adding custom field handling
- Implementing sprint creation and assignment

## Next Steps After Import

After importing the stories:

1. Set up your board view (Scrum or Kanban)
2. Create sprints and assign stories
3. Set up any automation rules
4. Adjust story points if needed

## Backup and Safety

Before running the script in production:
1. Consider testing on a sandbox Jira instance first
2. Keep a local backup of your JSON data
3. Be cautious when running the script multiple times to avoid duplicate issues
