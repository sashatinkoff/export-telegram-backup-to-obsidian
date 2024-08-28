# Telegram Backup to Obsidian Vault Converter

## Overview

This Python script converts your Telegram backup into an Obsidian Vault. 

## How to Use

1. **Prepare Your Backup**: Copy your Telegram backup into the `input` folder.
2. **Run the Script**: Execute the Python script. 
3. **Access the Vault**: The updated Obsidian Vault will be available in the `output` folder.

## File Structure

The resulting structure in the Obsidian Vault will be:

notes └── yyyy └── yyyy-MM-MMMM


Files are named in the format `YYYY-MM-dd HH:mm:ss.md`.

## Supported Features

- Converts all types of internal links:
  - Photos
  - Videos
  - Round video messages
  - Audio messages

## Dependencies

You might need to install additional modules via `pip`. The script will handle the conversion of all supported types of content.

## Notes

- Ensure that your backup is correctly placed in the `input` folder before running the script.
- Verify the `output` folder after execution to check the converted files.

## Installation

To install required Python modules, you may need to use `pip`. For example:

```bash
pip install -r requirements.txt
