const express = require('express')
const cors = require('cors')
const admin = require('firebase-admin')
const serviceAccount = require('./musiverse-e89c0-firebase-adminsdk-lan8j-d90c98ef11.json')
const app = express()
const port = process.env.PORT || 3000
const ytdl = require('ytdl-core')
const axios = require('axios')
const fs = require('fs')
const exec = require('child_process').exec

app.use(cors())

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'musiverse-e89c0.appspot.com'
})

const bucket = admin.storage().bucket()

app.use(express.json())

function formatarTexto(texto) {
  texto = texto.trim()
  const wordsToRemove = ['vevo', '- Topic', '(Official Music Video)', '(Official Audio)', '()']

  wordsToRemove.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'ig')
    texto = texto.replace(regex, '')
  })

  texto = texto.replace(/([a-z])([A-Z])/g, '$1 $2')
  texto = texto.trim()
  texto = texto.replace(/\b\w/g, c => c.toUpperCase())

  return texto
}

app.post('/', async (req, res) => {
  try {
    const videoURL = req.body.videoURL
    const audioOptions = {
      filter: 'audioonly'
    }

    const info = await ytdl.getInfo(videoURL)
    const videoTitle = formatarTexto(info.player_response.videoDetails.title)
    const channelName = formatarTexto(info.player_response.videoDetails.author)

    const uid = admin.firestore().collection('uids').doc().id
    const audioFilename = `${videoTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${channelName.replace(/[^a-zA-Z0-9]/g, '_')}_audio.mp3`
    const thumbnailFilename = `${videoTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${channelName.replace(/[^a-zA-Z0-9]/g, '_')}_thumbnail.jpg`

    const audioPath = `MusicasPostadas/${uid}/${audioFilename}`
    const thumbnailPath = `MusicasPostadas/${uid}/${thumbnailFilename}`

    await Promise.all([
      downloadAudioToFirebase(videoURL, audioOptions, bucket, audioPath),
      downloadThumbnailToFirebase(videoURL, bucket, thumbnailPath)
    ])

    const audioPublicUrl = `https://storage.googleapis.com/${bucket.name}/${audioPath}`

    await addHighResThumbnailToAudio(audioPublicUrl, videoTitle, channelName, audioPath)

    const thumbnailPublicUrl = `https://storage.googleapis.com/${bucket.name}/${thumbnailPath}`

    const videoInfo = {
      videoTitle,
      channelName,
      audioUrl: audioPublicUrl,
      thumbnailUrl: thumbnailPublicUrl,
      uid: uid
    }

    res.json(videoInfo)
  } catch (err) {
    console.error('Erro ao obter informações do vídeo:', err.message);
    if (err.message.includes('Status code: 410')) {
      console.error('O vídeo não está mais disponível ou foi removido.');
    }
    res.status(500).json({ error: 'Erro ao obter informações do vídeo', message: err.message });
  }
})

function downloadAudioToFirebase(videoURL, options, bucket, filename) {
  const audioStream = ytdl(videoURL, options)

  const upload = bucket.file(filename).createWriteStream({
    metadata: {
      contentType: 'audio/mpeg'
    },
    public: true
  })

  audioStream.pipe(upload)
    .on('finish', () => {
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`
      console.log('Áudio enviado para o Firebase Storage com sucesso!')
      console.log('Link para acessar o áudio:', publicUrl)
    })
    .on('error', (err) => console.error('Erro ao enviar o áudio:', err))
}

async function downloadThumbnailToFirebase(videoURL, bucket, filename) {
  try {
    const thumbnailURL = await getVideoThumbnailURL(videoURL, 'hqdefault')

    const response = await axios.get(thumbnailURL, { responseType: 'stream' })

    const upload = bucket.file(filename).createWriteStream({
      metadata: {
        contentType: 'image/jpeg'
      },
      public: true
    })

    response.data.pipe(upload)
      .on('finish', () => {
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`
        console.log('Capa do vídeo enviada para o Firebase Storage com sucesso!')
        console.log('Link para acessar a capa:', publicUrl)
      })
      .on('error', (err) => console.error('Erro ao enviar a capa do vídeo:', err))
  } catch (err) {
    console.log(err);
  }
}

async function getVideoThumbnailURL(videoURL, quality) {
  try {
    return `https://img.youtube.com/vi/${ytdl.getVideoID(videoURL)}/${quality}.jpg`
  } catch (err) {
    console.log(err);
  }
}

async function addHighResThumbnailToAudio(audioUrl, videoTitle, channelName, audioPath) {
  try {
    const tempAudioPath = `/tmp/${audioPath}`
    await bucket.file(audioPath).download({ destination: tempAudioPath })

    const highResThumbnailUrl = await getVideoThumbnailURL(audioUrl, 'maxresdefault')

    const tempThumbnailPath = `/tmp/${videoTitle}_${channelName}_thumbnail.jpg`
    const response = await axios.get(highResThumbnailUrl, { responseType: 'stream' })
    const tempThumbnailStream = fs.createWriteStream(tempThumbnailPath)
    response.data.pipe(tempThumbnailStream)

    const cmd = `ffmpeg -i "${tempAudioPath}" -i "${tempThumbnailPath}" -map 0 -map 1 -c copy -disposition:1 attached_pic -y "${tempAudioPath}_temp"`
    await exec(cmd)

    await bucket.upload(`${tempAudioPath}_temp`, { destination: audioPath, metadata: { contentType: 'audio/mpeg' } })

    fs.unlinkSync(tempAudioPath)
    fs.unlinkSync(tempThumbnailPath)
    fs.unlinkSync(`${tempAudioPath}_temp`)
  } catch (err) {
    console.log(err);
  }
}

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`)
})
