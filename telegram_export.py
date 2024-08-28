import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Optional, Tuple
from dataclasses import dataclass

@dataclass
class GeoResponse:
    latitude: float
    longitude: float

@dataclass
class TextEntityResponse:
    type: str
    text: str
    href: Optional[str] = None

@dataclass
class MessageResponse:
    id: int
    date: datetime
    file: Optional[str] = None
    photo: Optional[str] = None
    location_information: Optional[GeoResponse] = None
    text_entities: List[TextEntityResponse] = None

@dataclass
class Response:
    messages: List[MessageResponse]

# DateTimeFormatter and Gson equivalent in Python
date_formatter = "%Y-%m-%d %H-%M-%S"
gson_date_format = "%Y-%m-%dT%H:%M:%S"

def copy_folders(input_dir: Path, output_dir: Path):
    for folder in input_dir.iterdir():
        if folder.is_dir():
            dest_folder = output_dir / folder.name
            if dest_folder.exists():
                shutil.rmtree(dest_folder)
            shutil.copytree(folder, dest_folder)

def process(json_data: str, output_dir: Path):
    response_dict = json.loads(json_data)
    response = Response(
        messages=[
            MessageResponse(
                id=msg["id"],
                date=datetime.strptime(msg["date"], gson_date_format),
                file=msg.get("file"),
                photo=msg.get("photo"),
                location_information=GeoResponse(
                    latitude=msg["location_information"]["latitude"],
                    longitude=msg["location_information"]["longitude"]
                ) if msg.get("location_information") else None,
                text_entities=[
                    TextEntityResponse(
                        type=ent["type"],
                        text=ent["text"],
                        href=ent.get("href")
                    ) for ent in msg.get("text_entities", [])
                ]
            ) for msg in response_dict.get("messages", [])
        ]
    )

    messages = [
        msg for msg in response.messages 
    ]

    start = 0
    while start < len(messages):
        message = messages[start]
        text = create_text(message)
        attachments = None

        if has_attach(message):
            end = find_last_attach_post_index(start, messages, message.date)
            attachments = create_attachments(messages, start, end)
            start = end

        current_file_name = get_file_name(message)
        prev_file, next_file = generate_breadcrumb_links(start, messages)
        header = create_header(message, prev_file, next_file)
        folder_name = get_folder_name(message.date.year, message.date.month)

        post = f"{header}\n{text or ''}\n{attachments or ''}"

        # Сохраняем файл
        notes_path = output_dir / "notes"
        year_folder = notes_path / str(message.date.year)
        month_folder = year_folder / folder_name
        month_folder.mkdir(parents=True, exist_ok=True)
        with open(month_folder / f"{current_file_name}.md", "w") as f:
            f.write(post)

        start += 1

def get_file_name(message: MessageResponse) -> str:
    return message.date.strftime(date_formatter)

def generate_breadcrumb_links(start: int, messages: List[MessageResponse]) -> Tuple[Optional[str], Optional[str]]:
    prev_file = get_file_name(messages[start - 1]) if start > 0 else None
    next_file = get_file_name(messages[start + 1]) if start < len(messages) - 1 else None
    return prev_file, next_file

def get_folder_name(year: int, month: int) -> str:
    month_name = datetime(year, month, 1).strftime('%B')
    formatted_month = f"{month:02d}-{month_name}"
    return f"{year}-{formatted_month}"

def create_header(message: MessageResponse, prev_file: Optional[str], next_file: Optional[str]) -> str:
    time_format = message.date.strftime("%Y-%m-%d %H:%M:%S")
    hash_tags = [entity.text for entity in message.text_entities if entity.type == "hashtag"]

    header = f"---\nDate: {time_format}\n"
    
    if hash_tags:
        header += "tags:\n"
        header += "\n".join(f"  - {tag}" for tag in hash_tags)
        header += "\n"
    
    if message.location_information:
        header += f"Location: https://maps.google.com/?q={message.location_information.latitude},{message.location_information.longitude}\n"
    
    if prev_file:
        header += f"Back: \"[[{prev_file}]]\"\n"
    
    if next_file:
        header += f"Next: \"[[{next_file}]]\"\n"
    
    header += "---"
    
    return header

def create_text(message: MessageResponse) -> Optional[str]:
    return "\n".join(filter(None, (create_text_entity(entity) for entity in message.text_entities)))

def has_attach(message: MessageResponse) -> bool:
    return message.photo is not None or message.file is not None

def find_last_attach_post_index(index: int, messages: List[MessageResponse], created: datetime) -> int:
    threshold = timedelta(seconds=10)
    created_time = created

    for i in range(index, len(messages)):
        item = messages[i]
        if has_attach(item) and (item.date - created_time) <= threshold:
            continue
        return i - 1
    return index

def create_attachments(messages: List[MessageResponse], start: int, end: int) -> str:
    return "\n".join(f"![]({msg.file or msg.photo})" for msg in messages[start:end + 1])

def create_text_entity(entity: TextEntityResponse) -> Optional[str]:
    entity_type_mapping = {
        "plain": entity.text,
        "blockquote": f"> {entity.text}",
        "pre": f"```\n{entity.text}\n```",
        "spoiler": entity.text,
        "text_link": f"[{entity.text}]({entity.href})",
        "italic": f"*{entity.text}*",
        "link": f"[{entity.text}]({entity.text})",
        "bold": f"**{entity.text}**",
        "strikethrough": f"~~{entity.text}~~",
        "underline": f"++{entity.text}++",
    }
    return entity_type_mapping.get(entity.type)

def main(input_dir: Path = Path("input"), output_dir: Path = Path("output")):
    # Копируем папки из input в output
    copy_folders(input_dir, output_dir)

    # Загружаем JSON из файла result.json
    with open(input_dir / "result.json", "r") as json_file:
        json_data = json_file.read()

    # Обрабатываем JSON и сохраняем результаты в output
    process(json_data, output_dir)

if __name__ == "__main__":
    main()
