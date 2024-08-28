
private val gson: Gson = GsonBuilder()
    .setDateFormat("yyyy-MM-dd'T'HH:mm:ss")
    .create()

private val dateFormatter: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH-mm-ss")

private fun copyFolders(input: File, output: File){
    for(folder in input.listFiles().orEmpty().filter { it.isDirectory }){
        // copy whole folder to output directory
    }
}

private fun process(json: String) {
    val list = gson.fromJson<Response>(json).messages
        .filter { it.id in 20..31 }

    var start = 0
    val calendar = Calendar.getInstance()

    while (start < list.size) {
        val message = list[start]
        val text = createText(message)
        var attachments: String? = null

        if (hasAttach(message)) {
            val end = findLastAttachPostIndex(start, list, message.date)
            attachments = createAttachments(list, start, end)
            start = end
        }

        calendar.time = message.date
        val currentFileName = getFileName(message)
        val (prevFile, nextFile) = generateBreadCrumbLinks(start, list)
        val header = createHeader(message, prevFile, nextFile)
        val folderName = getFolderName(calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH))

        val post = buildString {
            append(header)
            append(text)
            append(attachments)
        }

        // сохраянем в File

        start++
    }
}

private fun getFileName(message: MessageResponse): String {
    return dateFormatter.format(message.date.toInstant().atZone(ZoneId.systemDefault()).toLocalDateTime())
}

private fun generateBreadCrumbLinks(start: Int, list: List<MessageResponse>): Pair<String?, String?> {
    val prevFile = list.getOrNull(start - 1)?.let { getFileName(it) }
    val nextFile = list.getOrNull(start + 1)?.let { getFileName(it) }
    return Pair(prevFile, nextFile)
}

private fun getFolderName(year: Int, month: Int): String {
    val monthName = Month.of(month).name.lowercase().replaceFirstChar { it.uppercase() }
    val formattedMonth = String.format("%02d", month)
    return "notes/$year-$formattedMonth-$monthName"
}

private fun createHeader(message: MessageResponse, prevFile: String?, nextFile: String?) = buildString {
    val timeFormat = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.MEDIUM)
    val hashTags = message.entities.filter { it.type == "hashtag" }

    append("---\n")
    append("Date: ", timeFormat.format(message.date))

    if (hashTags.isNotEmpty()) {
        append("\n", "tags:")
        for (tag in hashTags) {
            append("\n", "  - ${tag.text}")
        }
    }

    message.geo?.let {
        append("\n", "Location: ", "[Open map](https://maps.google.com/?q=${it.lat},${it.lng})")
    }

    prevFile?.let { append("\n", "[[$it|Back]]") }
    nextFile?.let { append("\n", "[[$it|Next]]") }

    append("\n---")
}

private fun createText(message: MessageResponse): String? {
    return message.entities.joinToString(separator = "\n") {
        createText(it).orEmpty()
    }.takeIf { it.isNotBlank() }
}

private fun hasAttach(message: MessageResponse): Boolean {
    return message.photo != null || message.file != null
}

private fun findLastAttachPostIndex(index: Int, list: List<MessageResponse>, created: Date): Int {
    val treshold = 10
    val createdTime = created.time

    return (index until list.size).takeWhile { i ->
        val item = list[i]
        val seconds = TimeUnit.MILLISECONDS.toSeconds(item.date.time - createdTime)
        hasAttach(item) && seconds <= treshold
    }.lastOrNull() ?: index
}

private fun createAttachments(list: List<MessageResponse>, start: Int, end: Int): String {
    return buildString {
        for (i in start..end) {
            list[i].let { item ->
                val attach = item.file ?: item.photo ?: return@let
                append("\n", "![]($attach)")
            }
        }
    }
}

private fun createText(entity: TextEntityResponse): String? {
    return when (entity.type) {
        "plain" -> entity.text
        "blockquote" -> "> ${entity.text}"
        "pre" -> "```\n${entity.text}\n```"
        "spoiler" -> entity.text
        "text_link" -> "[${entity.text}](${entity.href})"
        "italic" -> "*${entity.text}*"
        "link" -> "[${entity.text}](${entity.text})"
        "bold" -> "**${entity.text}**"
        "strikethrough" -> "~~${entity.text}~~"
        "underline" -> "++${entity.text}++"
        else -> null
    }
}


data class Response(@SerializedName("messages") val messages: List<MessageResponse>)
data class MessageResponse(
    @SerializedName("id") val id: Int,
    @SerializedName("date") val date: Date,
    @SerializedName("file") val file: String?,
    @SerializedName("photo") val photo: String?,
    @SerializedName("location_information") val geo: GeoResponse?,
    @SerializedName("text_entities") val entities: List<TextEntityResponse>
)

data class TextEntityResponse(
    @SerializedName("type") val type: String,
    @SerializedName("text") val text: String,
    @SerializedName("href") val href: String?,
)

data class GeoResponse(@SerializedName("latitude") val lat: Double, @SerializedName("longitude") val lng: Double)
