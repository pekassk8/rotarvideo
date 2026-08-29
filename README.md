# 🎬 RotarVideo

App web (PWA) para **girar tus videos al instante, sin perder calidad**. Pensada para iPhone: se instala en la pantalla de inicio como una app normal y corrige de un toque esos videos que salen volteados, sin tener que entrar a Fotos → Editar → girar 3 veces, video por video.

- ✅ Selecciona **varios videos a la vez** desde tu Fototeca
- ✅ Cada video viene con **3 giros (270°)** ya aplicados, igual que en Fotos — y puedes ajustarlo con vista previa
- ✅ **Instantáneo**, incluso con videos grandes: no recodifica, solo corrige la orientación en los metadatos (lo mismo que hace la edición de Fotos)
- ✅ **Sin pérdida de calidad** y sin subir nada a internet: todo pasa dentro de tu iPhone
- ✅ Funciona **sin conexión** una vez instalada
- ✅ Guarda el resultado directo en tu **Fototeca** con el menú Compartir

## 1. Publicar la app (una sola vez, con GitHub Pages)

La app es 100 % estática, así que GitHub la puede servir gratis:

1. Fusiona esta rama en `main` (o abre el repo y pulsa el botón de merge del pull request si hay uno).
2. En GitHub, entra a **Settings → Pages** de este repositorio.
3. En **Source** elige **“Deploy from a branch”**.
4. En **Branch** elige `main` y la carpeta `/ (root)`. Guarda.
5. Espera 1–2 minutos. Tu app quedará en:

   **https://pekassk8.github.io/rotarvideo/**

> Cualquier cambio que subas a `main` se publica solo.

## 2. Instalarla en el iPhone

1. Abre **https://pekassk8.github.io/rotarvideo/** en **Safari**.
2. Toca el botón **Compartir** (el cuadrado con la flecha hacia arriba).
3. Toca **“Añadir a pantalla de inicio”** y confirma.
4. Ya tienes el icono de RotarVideo como una app más. 🎉

## 3. Cómo se usa

1. Abre la app y toca **🎞️ Elegir videos**. Selecciona de tu Fototeca todos los que quieras (puedes marcar varios).
2. Cada video aparece con **3 giros (270°)** aplicados en la vista previa, que es tu caso habitual. Si alguno necesita otra cosa, toca **⟲ Girar 90°** hasta que se vea bien (el botón gira en el mismo sentido que el de Fotos).
3. Toca **Guardar** en un video, o **💾 Guardar todos** abajo.
4. En el menú de compartir que se abre, toca **“Guardar video”** (o “Guardar X videos”). Los videos corregidos aparecen en tu Fototeca con el nombre original + `-girado`.

Los originales no se tocan; puedes borrarlos después si quieres.

## Cómo funciona por dentro

Los videos MP4/MOV llevan una **matriz de orientación** en sus metadatos (átomo `moov → trak → tkhd`). Es el mismo mecanismo que usa el iPhone para marcar si un video se grabó en vertical u horizontal, y lo que toca la app Fotos cuando le das a girar. RotarVideo lee esa matriz, le suma el giro que elijas y reescribe solo esos 44 bytes — el resto del archivo se copia tal cual. Por eso es instantáneo aunque el video pese gigas, y no hay recompresión ni pérdida.

## Limitaciones

- Formatos compatibles: **MP4 y MOV** (lo que graba cualquier app de iPhone). No sirve para AVI/MKV.
- Al elegir videos de la Fototeca, iOS los “prepara” antes de entregarlos a la app; con videos muy largos esa barra de progreso inicial es de iOS, no de la app.
- Algún reproductor muy antiguo ignora la matriz de orientación (les pasa lo mismo con los videos verticales normales del iPhone). Los reproductores actuales, la Fototeca, AirDrop, WhatsApp, etc. la respetan.

## Desarrollo

Sin dependencias ni build: HTML + CSS + JavaScript puro (`index.html`, `styles.css`, `app.js`, `sw.js`). Para probar en local:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Pruebas del núcleo de rotación (genera MP4/MOV sintéticos y verifica byte a byte la matriz escrita):

```bash
python3 tests/gen_test_mp4.py tests/media
node tests/test_core.mjs
```

Los iconos se regeneran con `python3 tools/gen_icons.py icons`.
