# export-telegram-backup-to-obsidian


Telegram Backup to Obsidian Vault Converter
Overview
This Python script converts your Telegram backup into an Obsidian Vault.

How to Use
Prepare Your Backup: Copy your Telegram backup into the input folder.
Run the Script: Execute the Python script.
Access the Vault: The updated Obsidian Vault will be available in the output folder.
File Structure
The resulting structure in the Obsidian Vault will be:

markdown
Копировать код
- notes
  - yyyy
     - yyyy-MM-MMMM
Files are named in the format YYYY-MM-dd HH:mm:ss.md.

Dependencies
You might need to install additional modules via pip. The script will handle the conversion of all types of internal links, including photos, videos, round video messages, and audio messages.

Notes
Ensure that your backup is correctly placed in the input folder before running the script.
Verify the output folder after execution to check the converted files.
Feel free to adjust any specifics or add any additional instructions if needed!
