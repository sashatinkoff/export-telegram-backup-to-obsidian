import os
import json
import shutil
from datetime import datetime
from dateutil import parser
from pathlib import Path

class TelegramExport:
    def __init__(self):
        self.date_format = "%Y-%m-%dT%H:%M:%S"
        self.file_date_format = "%Y-%m-%d %H-%M-%S"

    def save_posts(self, posts, output_folder):
        for index, post in enumerate(posts):
            prev_file = posts[index - 1].get('file_name') if index > 0 else None
            next_file = posts[index + 1].get('file_name') if index < len(posts) - 1 else None
            header = self.create_header(post, next_file, prev_file)

            text = f"{header}\n\n{post['text']}"
            file_path = self.save_to_file(text, post['date'], post['file_name'], output_folder)
            print(f"Saved {index + 1}/{len(posts)}, file={file_path}")

    def copy_folders(self, input_folder, output_folder):
        if not os.path.exists(output_folder):
            os.makedirs(output_folder)

        for folder_name in os.listdir(input_folder):
            src_folder = os.path.join(input_folder, folder_name)
            dest_folder = os.path.join(output_folder, folder_name)
            if os.path.isdir(src_folder):
                print(f"Copying {folder_name}")
                try:
                    shutil.copytree(src_folder, dest_folder, dirs_exist_ok=True)
                except Exception as e:
                    print(f"Error copying {folder_name}: {e}")

    def save_to_file(self, text, date, file_name, output_folder):
        date_obj = parser.parse(date)
        folder_name = self.get_folder_name(date_obj.year, date_obj.month)
        folder_path = os.path.join(output_folder, folder_name)

        if not os.path.exists(folder_path):
            os.makedirs(folder_path)

        file_path = os.path.join(folder_path, file_name)
        with open(file_path, 'w') as f:
            f.write(text)

        return file_path

    def get_folder_name(self, year, month):
        month_name = datetime(year, month, 1).strftime('%B')
        formatted_month = f"{month:02d}"
        return f"notes/{year}/{year}-{formatted_month}-{month_name.capitalize()}"

    def get_posts(self, json_data):
        messages = json_data.get('messages', [])
        posts = []
        start = 0

        while start < len(messages):
            message = messages[start]
            text = [self.create_text(message)]

            next_start = start + 1
            threshold = 120  # 2 minutes in seconds

            while next_start < len(messages):
                next_message = messages[next_start]
                time_diff = (parser.parse(next_message['date']) - parser.parse(message['date'])).total_seconds()
                if time_diff >= threshold:
                    break

                text.append(self.create_text(next_message))
                next_start += 1

            post = {
                'id': message['id'],
                'date': message['date'],
                'text': "\n".join(filter(None, text)),
                'file_name': self.get_file_name(message),
                'hash_tags': [entity['text'].replace('#', '') for entity in message.get('text_entities', []) if entity['type'] == 'hashtag'],
                'geo': message.get('location_information')
            }
            posts.append(post)
            start = next_start

        return posts

    def create_text(self, message):
        entities = message.get('text_entities', [])

        while entities and entities[-1].get('type') == "plain" and not entities[-1].get('text'):
            entities.pop()

        while entities and entities[-1].get('type') == "hashtag":
            entities.pop()


        return self.create_text2(entities, message.get('photo'), message.get('file'))

    def create_text2(self, entities, photo, file):
        result = []
    
        # Соединяем текстовые сущности
        text = ''.join([self.create_text_entity(entity) or '' for entity in entities]).strip()
        
        if text:
            result.append(text)

        # Получаем вложение (photo или file) и обрабатываем его
        attach = photo or file
        if attach and '/' in attach:
            attach = attach[attach.rfind('/') + 1:]
        
        if attach:
            file_extension = attach.split('.')[-1].lower()
            if file_extension in ["m4v", "mp4", "mov", "ogg"]:
                code = f"![[{attach}]]"
            elif file_extension == "pdf":
                code = f"[[{attach}]]"
            else:
                code = f"![]({attach})"
            result.append(code)

        return '\n'.join(result)

    def create_text_entity(self, entity):
        entity_type = entity['type']
        text = entity['text']
        if entity_type == "hashtag":
            return text.replace('#', '')
        elif entity_type == "plain":
            return text
        elif entity_type == "blockquote":
            return "> " + text.replace('\n', '\n> ')
        elif entity_type == "pre":
            return f"```\n{text}\n```"
        elif entity_type == "spoiler":
            return text
        elif entity_type == "text_link":
            return f"[{text}]({entity.get('href')})"
        elif entity_type == "italic":
            return f"*{text}*"
        elif entity_type == "link":
            return f"[{text}]({text})"
        elif entity_type == "bold":
            return f"**{text}**"
        elif entity_type == "strikethrough":
            return f"~~{text}~~"
        elif entity_type == "underline":
            return f"++{text}++"
        else:
            return None

    def create_header(self, post, next_file, prev_file):
        time_format = "%b %d, %Y %I:%M %p"
        date_str = datetime.strptime(post['date'], self.date_format).strftime(time_format)
        header = f"---\nDate: {date_str}"

        if post.get('hash_tags'):
            header += "\ntags:\n" + "\n".join(f"  - {tag}" for tag in post['hash_tags'])

        if post.get('geo'):
            geo = post['geo']
            header += f"\nLocation: [Open map](https://maps.google.com/?q={geo['latitude']},{geo['longitude']})"

        if prev_file:
            header += f'\nBack: "[[{prev_file}]]"'
        if next_file:
            header += f'\nNext: "[[{next_file}]]"'

        return header + "\n---"

    def get_file_name(self, message):
        date_obj = parser.parse(message['date'])
        return date_obj.strftime(self.file_date_format) + ".md"

def main():
    input_folder = "input"
    output_folder = "output"

    export = TelegramExport()
    export.copy_folders(input_folder, output_folder)

    with open(os.path.join(input_folder, "result.json"), "r") as f:
        json_data = json.load(f)

    posts = export.get_posts(json_data)
    export.save_posts(posts, output_folder)

if __name__ == "__main__":
    main()
