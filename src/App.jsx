import React, { useEffect, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';

// Helper to get filename without extension
function getFileStem(filename) {
  if (typeof filename !== 'string') return '';
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return filename;
  return filename.substring(0, lastDot);
}

const HANDLE_DEFINITIONS = [
  { key: 'nw', x: 0, y: 0 },
  { key: 'n', x: 0.5, y: 0 },
  { key: 'ne', x: 1, y: 0 },
  { key: 'e', x: 1, y: 0.5 },
  { key: 'se', x: 1, y: 1 },
  { key: 's', x: 0.5, y: 1 },
  { key: 'sw', x: 0, y: 1 },
  { key: 'w', x: 0, y: 0.5 },
]

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function getNormalizedRect(start, current) {
  const left = Math.min(start.x, current.x)
  const top = Math.min(start.y, current.y)
  const width = Math.abs(current.x - start.x)
  const height = Math.abs(current.y - start.y)
  return { left, top, width, height }
}

function readImageDimensions(url) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      resolve({ width: null, height: null })
    }
    image.src = url
  })
}


function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}





function App() {
    // Helper to update the current image (active or fullscreen)
    function updateCurrentImage(updater) {
      setImages((prev) => prev.map((img) => {
        if (fullscreenImageId && img.id === fullscreenImageId) {
          return updater(img);
        }
        if (!fullscreenImageId && img.id === activeImageId) {
          return updater(img);
        }
        return img;
      }));
    }
  // --- React state and refs ---
  const [images, setImages] = useState([]);
  const [activeImageId, setActiveImageId] = useState(null);
  const [fullscreenImageId, setFullscreenImageId] = useState(null);
  const [selectedClass, setSelectedClass] = useState('');
  const [classOptions, setClassOptions] = useState([]);
  const [classDraft, setClassDraft] = useState('');
  const [exportFormat, setExportFormat] = useState('coco');
  const [drawStart, setDrawStart] = useState(null);
  const [drawCurrent, setDrawCurrent] = useState(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
  const [editSession, setEditSession] = useState(null);
  const [hoverPoint, setHoverPoint] = useState(null);
  const [canvasCursor, setCanvasCursor] = useState('crosshair');
  const [zoom, setZoom] = useState(100);
  const canvasRef = useRef(null);
  const modalImageRef = useRef(null);
  const objectUrlsRef = useRef([]);

  // --- Derived values ---
  const activeImageIndex = useMemo(() => images.findIndex((img) => img.id === activeImageId), [images, activeImageId]);
  const activeImage = useMemo(() => images.find((img) => img.id === activeImageId), [images, activeImageId]);
  const fullscreenImage = useMemo(() => images.find((img) => img.id === fullscreenImageId), [images, fullscreenImageId]);

  // --- Effects and logic (moved from top level) ---
  useEffect(() => {
    if (!classOptions.length) {
      setSelectedClass('');
      return;
    }
    if (!classOptions.includes(selectedClass)) {
      setSelectedClass(classOptions[0]);
    }
  }, [classOptions, selectedClass]);

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    setDrawStart(null);
    setDrawCurrent(null);
    setSelectedAnnotationId(null);
    setHoverPoint(null);
    setCanvasCursor('crosshair');
    setEditSession(null);
    setZoom(100);
  }, [activeImageId]);

  useEffect(() => {
    if (!fullscreenImageId) return;
    const element = canvasRef.current;
    if (!element) return;
    const handleWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 10 : -10;
      setZoom((previous) => {
        const nextZoom = previous + step;
        return Math.max(25, Math.min(1000, nextZoom));
      });
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, [fullscreenImageId]);

  // --- All other logic and handlers remain unchanged ---

  const cursorForHandle = (handle) => {
    if (handle === 'n' || handle === 's') {
      return 'ns-resize'
    }

    if (handle === 'e' || handle === 'w') {
      return 'ew-resize'
    }

    if (handle === 'nw' || handle === 'se') {
      return 'nwse-resize'
    }

    if (handle === 'ne' || handle === 'sw') {
      return 'nesw-resize'
    }

    return 'crosshair'
  }

  const hitTestAnnotation = (normalizedX, normalizedY, width, height) => {
    if (!activeImage) {
      return null
    }

    const toleranceX = 8 / width
    const toleranceY = 8 / height
    const ordered = [...activeImage.annotations].reverse()

    for (const annotation of ordered) {
      for (const handle of HANDLE_DEFINITIONS) {
        const handleX = annotation.x + annotation.width * handle.x
        const handleY = annotation.y + annotation.height * handle.y
        const isOnHandle =
          Math.abs(normalizedX - handleX) <= toleranceX &&
          Math.abs(normalizedY - handleY) <= toleranceY

        if (isOnHandle) {
          return { annotation, action: 'resize', handle: handle.key }
        }
      }

      const inBox =
        normalizedX >= annotation.x &&
        normalizedX <= annotation.x + annotation.width &&
        normalizedY >= annotation.y &&
        normalizedY <= annotation.y + annotation.height

      if (inBox) {
        return { annotation, action: 'move' }
      }
    }

    return null
  }

  const moveImage = (delta) => {
    if (activeImageIndex < 0) {
      return
    }

    const targetIndex = activeImageIndex + delta
    if (targetIndex < 0 || targetIndex >= images.length) {
      return
    }

    setActiveImageId(images[targetIndex].id)
  }

  const removeAnnotation = (annotationId) => {
    updateCurrentImage((image) => ({
      ...image,
      annotations: image.annotations.filter((item) => item.id !== annotationId),
    }))

    if (selectedAnnotationId === annotationId) {
      setSelectedAnnotationId(null)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
        return
      }

      if (event.ctrlKey && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (!activeImage) {
          return
        }

        setImages((previous) =>
          previous.map((image) =>
            image.id === activeImageId
              ? { ...image, annotations: image.annotations.slice(0, -1) }
              : image,
          ),
        )
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedAnnotationId) {
        event.preventDefault()
        removeAnnotation(selectedAnnotationId)
      }

      if (event.key === '[') {
        event.preventDefault()
        adjustZoom(-10)
      }

      if (event.key === ']') {
        event.preventDefault()
        adjustZoom(10)
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        moveImage(1)
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        moveImage(-1)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeImage, activeImageId, selectedAnnotationId, activeImageIndex, images])

  const handleImageUpload = async (event) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) {
      return
    }

    const newImages = await Promise.all(
      files.map(async (file) => {
        const url = URL.createObjectURL(file)
        objectUrlsRef.current.push(url)
        const dimensions = await readImageDimensions(url)

        return {
          id: crypto.randomUUID(),
          fileName: file.name,
          url,
          naturalWidth: dimensions.width,
          naturalHeight: dimensions.height,
          annotations: [],
        }
      }),
    )

    setImages((previous) => {
      const merged = [...previous, ...newImages]
      if (!activeImageId) {
        setActiveImageId(newImages[0].id)
      }
      return merged
    })

    event.target.value = ''
  }

  const addClassOption = () => {
    const normalized = classDraft.trim()
    if (!normalized || classOptions.includes(normalized)) {
      return
    }

    setClassOptions((previous) => [...previous, normalized])
    setSelectedClass(normalized)
    setClassDraft('')
  }

  const removeClassOption = (className) => {
    setClassOptions((previous) => previous.filter((item) => item !== className))
    if (selectedClass === className) {
      const next = classOptions.find((item) => item !== className) || ''
      setSelectedClass(next)
    }
  }

  const readPointerPosition = (event) => {
    // Use modal image bounds if modal is open, otherwise use canvasRef
    let bounds;
    if (fullscreenImageId && modalImageRef.current) {
      bounds = modalImageRef.current.getBoundingClientRect();
    } else {
      bounds = canvasRef.current?.getBoundingClientRect();
    }
    if (!bounds) {
      return null;
    }
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const clampedX = Math.max(0, Math.min(x, bounds.width));
    const clampedY = Math.max(0, Math.min(y, bounds.height));
    return {
      x: clampedX,
      y: clampedY,
      width: bounds.width,
      height: bounds.height,
    };
  };

  const handlePointerDown = (event) => {
    const currentImage = fullscreenImageId ? fullscreenImage : activeImage;
    if (!currentImage) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = readPointerPosition(event);
    if (!pointer) {
      return;
    }
    const normalizedX = pointer.x / pointer.width;
    const normalizedY = pointer.y / pointer.height;
    const hit = hitTestAnnotation(normalizedX, normalizedY, pointer.width, pointer.height);
    if (hit) {
      setSelectedAnnotationId(hit.annotation.id);
      if (hit.action === 'resize') {
        setCanvasCursor(cursorForHandle(hit.handle));
        setEditSession({
          action: 'resize',
          handle: hit.handle,
          annotationId: hit.annotation.id,
          startPointer: { x: normalizedX, y: normalizedY },
          startBox: {
            x: hit.annotation.x,
            y: hit.annotation.y,
            width: hit.annotation.width,
            height: hit.annotation.height,
          },
          minWidth: 8 / pointer.width,
          minHeight: 8 / pointer.height,
        });
        return;
      }
      setCanvasCursor('move');
      setEditSession({
        action: 'move',
        annotationId: hit.annotation.id,
        startPointer: { x: normalizedX, y: normalizedY },
        startBox: {
          x: hit.annotation.x,
          y: hit.annotation.y,
          width: hit.annotation.width,
          height: hit.annotation.height,
        },
      });
      return;
    }
    if (!selectedClass) {
      return;
    }
    setSelectedAnnotationId(null);
    setDrawStart(pointer);
    setDrawCurrent(pointer);
    setCanvasCursor('crosshair');
  } 


  const handlePointerMove = (event) => {
    const pointer = readPointerPosition(event);
    if (!pointer) {
      return;
    }
    setHoverPoint(pointer);
    const normalizedX = pointer.x / pointer.width;
    const normalizedY = pointer.y / pointer.height;
    if (editSession) {
      if (editSession.action === 'move') {
        const deltaX = normalizedX - editSession.startPointer.x;
        const deltaY = normalizedY - editSession.startPointer.y;
        updateCurrentAnnotation(editSession.annotationId, (annotation) => {
          const nextX = clamp(
            editSession.startBox.x + deltaX,
            0,
            1 - editSession.startBox.width,
          );
          const nextY = clamp(
            editSession.startBox.y + deltaY,
            0,
            1 - editSession.startBox.height,
          );
          return {
            ...annotation,
            x: nextX,
            y: nextY,
          };
        });
        return;
      }
      if (editSession.action === 'resize') {
        updateCurrentAnnotation(editSession.annotationId, (annotation) => {
          const minWidth = editSession.minWidth;
          const minHeight = editSession.minHeight;
          let left = editSession.startBox.x;
          let top = editSession.startBox.y;
          let right = editSession.startBox.x + editSession.startBox.width;
          let bottom = editSession.startBox.y + editSession.startBox.height;
          if (editSession.handle.includes('w')) {
            left = clamp(normalizedX, 0, right - minWidth);
          }
          if (editSession.handle.includes('e')) {
            right = clamp(normalizedX, left + minWidth, 1);
          }
          if (editSession.handle.includes('n')) {
            top = clamp(normalizedY, 0, bottom - minHeight);
          }
          if (editSession.handle.includes('s')) {
            bottom = clamp(normalizedY, top + minHeight, 1);
          }
          return {
            ...annotation,
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
          };
        });
        return;
      }
    }
    if (!drawStart) {
      const hit = hitTestAnnotation(normalizedX, normalizedY, pointer.width, pointer.height);
      if (!hit) {
        setCanvasCursor('crosshair');
        return;
      }
      if (hit.action === 'move') {
        setCanvasCursor('move');
        return;
      }
      setCanvasCursor(cursorForHandle(hit.handle));
      return;
    }
    setDrawCurrent(pointer);
  } 


  const handlePointerUp = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (editSession) {
      setEditSession(null);
      setCanvasCursor('crosshair');
      return;
    }
    const currentImage = fullscreenImageId ? fullscreenImage : activeImage;
    if (!drawStart || !currentImage || !selectedClass) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }
    const pointer = readPointerPosition(event);
    if (!pointer) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }
    const rect = getNormalizedRect(drawStart, pointer);
    if (rect.width < 5 || rect.height < 5) {
      setDrawStart(null);
      setDrawCurrent(null);
      return;
    }
    const newAnnotationId = crypto.randomUUID();
    updateCurrentImage((image) => ({
      ...image,
      annotations: [
        ...image.annotations,
        {
          id: newAnnotationId,
          className: selectedClass,
          x: rect.left / pointer.width,
          y: rect.top / pointer.height,
          width: rect.width / pointer.width,
          height: rect.height / pointer.height,
        },
      ],
    }));
    setSelectedAnnotationId(newAnnotationId);
    setDrawStart(null);
    setDrawCurrent(null);
    setCanvasCursor('crosshair');
  } 

  const handlePointerCancel = () => {
    setDrawStart(null)
    setDrawCurrent(null)
    setEditSession(null)
    setCanvasCursor('crosshair')
  }

  const handlePointerLeave = () => {
    setHoverPoint(null)
    if (!drawStart && !editSession) {
      setCanvasCursor('crosshair')
    }
  }

  const undoLastAnnotation = () => {
    updateCurrentImage((image) => ({
      ...image,
      annotations: image.annotations.slice(0, -1),
    }))
    setSelectedAnnotationId(null)
  }

  const updateImageMeta = (event) => {
    const target = event.currentTarget
    updateCurrentImage((image) => ({
      ...image,
      naturalWidth: target.naturalWidth,
      naturalHeight: target.naturalHeight,
    }))
  }

  const buildCocoPayload = () => {
    const validImages = images.filter(
      (image) => image.naturalWidth && image.naturalHeight,
    )

    const usedClasses = new Set(classOptions)
    images.forEach((image) => {
      image.annotations.forEach((annotation) => usedClasses.add(annotation.className))
    })

    const categories = Array.from(usedClasses).map((className, index) => ({
      id: index + 1,
      name: className,
      supercategory: 'object',
    }))
    const categoryIdByName = new Map(
      categories.map((category) => [category.name, category.id]),
    )

    const imageEntries = validImages.map((image, index) => ({
      id: index + 1,
      file_name: image.fileName,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }))
    const imageIdByLocalId = new Map(
      validImages.map((image, index) => [image.id, index + 1]),
    )

    let annotationId = 1
    const annotationEntries = []

    validImages.forEach((image) => {
      const imageId = imageIdByLocalId.get(image.id)
      const imageWidth = image.naturalWidth
      const imageHeight = image.naturalHeight

      image.annotations.forEach((annotation) => {
        const categoryId = categoryIdByName.get(annotation.className)
        if (!categoryId || !imageId) {
          return
        }

        const x = annotation.x * imageWidth
        const y = annotation.y * imageHeight
        const width = annotation.width * imageWidth
        const height = annotation.height * imageHeight

        annotationEntries.push({
          id: annotationId,
          image_id: imageId,
          category_id: categoryId,
          bbox: [x, y, width, height],
          area: width * height,
          iscrowd: 0,
        })

        annotationId += 1
      })
    })

    return {
      info: {
        description: 'Annotation Tool Export',
        version: '1.0',
        date_created: new Date().toISOString(),
      },
      images: imageEntries,
      annotations: annotationEntries,
      categories,
    }
  }

  const downloadAnnotations = async () => {
    const cocoPayload = buildCocoPayload()

    if (exportFormat === 'coco') {
      const blob = new Blob([JSON.stringify(cocoPayload, null, 2)], {
        type: 'application/json',
      })
      downloadBlob(blob, 'fasterrcnn_coco_annotations.json')
      return
    }

    if (exportFormat === 'yolo') {
      const zip = new JSZip()
      const labelsFolder = zip.folder('labels')

      const categoryNames = cocoPayload.categories
        .sort((a, b) => a.id - b.id)
        .map((item) => item.name)
      const categoryIndexById = new Map(
        cocoPayload.categories.map((category) => [category.id, category.id - 1]),
      )

      cocoPayload.images.forEach((image) => {
        const lines = cocoPayload.annotations
          .filter((annotation) => annotation.image_id === image.id)
          .map((annotation) => {
            const [x, y, width, height] = annotation.bbox
            const xCenter = (x + width / 2) / image.width
            const yCenter = (y + height / 2) / image.height
            const w = width / image.width
            const h = height / image.height
            const classId = categoryIndexById.get(annotation.category_id)
            return `${classId} ${xCenter.toFixed(6)} ${yCenter.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`
          })

        labelsFolder.file(`${getFileStem(image.file_name)}.txt`, `${lines.join('\n')}\n`)
      })

      const yaml = [
        'path: ./dataset',
        'train: images/train',
        'val: images/val',
        `nc: ${categoryNames.length}`,
        `names: [${categoryNames.map((name) => `'${name.replace(/'/g, "\\'")}'`).join(', ')}]`,
        '',
      ].join('\n')

      zip.file('data.yaml', yaml)
      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, 'yolo_annotations.zip')
      return
    }

    if (exportFormat === 'voc') {
      const zip = new JSZip()
      const annotationsFolder = zip.folder('Annotations')

      const annotationByImageId = new Map()
      cocoPayload.annotations.forEach((annotation) => {
        if (!annotationByImageId.has(annotation.image_id)) {
          annotationByImageId.set(annotation.image_id, [])
        }
        annotationByImageId.get(annotation.image_id).push(annotation)
      })

      const categoryNameById = new Map(
        cocoPayload.categories.map((category) => [category.id, category.name]),
      )

      cocoPayload.images.forEach((image) => {
        const records = annotationByImageId.get(image.id) || []
        const objectsXml = records
          .map((record) => {
            const [x, y, width, height] = record.bbox
            const xmin = Math.max(1, Math.round(x))
            const ymin = Math.max(1, Math.round(y))
            const xmax = Math.min(image.width, Math.round(x + width))
            const ymax = Math.min(image.height, Math.round(y + height))
            const className = categoryNameById.get(record.category_id) || 'object'

            return [
              '  <object>',
              `    <name>${className}</name>`,
              '    <pose>Unspecified</pose>',
              '    <truncated>0</truncated>',
              '    <difficult>0</difficult>',
              '    <bndbox>',
              `      <xmin>${xmin}</xmin>`,
              `      <ymin>${ymin}</ymin>`,
              `      <xmax>${xmax}</xmax>`,
              `      <ymax>${ymax}</ymax>`,
              '    </bndbox>',
              '  </object>',
            ].join('\n')
          })
          .join('\n')

        const xml = [
          '<annotation>',
          '  <folder>images</folder>',
          `  <filename>${image.file_name}</filename>`,
          '  <size>',
          `    <width>${image.width}</width>`,
          `    <height>${image.height}</height>`,
          '    <depth>3</depth>',
          '  </size>',
          '  <segmented>0</segmented>',
          objectsXml,
          '</annotation>',
          '',
        ].join('\n')

        annotationsFolder.file(`${getFileStem(image.file_name)}.xml`, xml)
      })

      zip.file(
        'classes.txt',
        `${cocoPayload.categories
          .sort((a, b) => a.id - b.id)
          .map((item) => item.name)
          .join('\n')}\n`,
      )

      const blob = await zip.generateAsync({ type: 'blob' })
      downloadBlob(blob, 'pascal_voc_annotations.zip')
    }
  }

  const setClampedZoom = (nextZoom) => {
    const safeZoom = Math.max(25, Math.min(1000, nextZoom))
    setZoom(safeZoom)
  }

  const adjustZoom = (delta) => {
    setZoom((previous) => {
      const nextZoom = previous + delta
      return Math.max(25, Math.min(1000, nextZoom))
    })
  }

  const previewRect =
    drawStart && drawCurrent ? getNormalizedRect(drawStart, drawCurrent) : null

  const totalAnnotations = images.reduce(
    (sum, image) => sum + image.annotations.length,
    0,
  );

  // --- JSX render (copied from previous App) ---
  return (
    <>
      <div className="saas-shell">
        {/* Main workspace UI (hidden when modal is open) */}
        {!fullscreenImageId && (
          <>
            <aside className="app-nav">
              <div className="brand">
                <div className="brand-dot" />
                <div>
                  <h1>AnnotateFlow</h1>
                  <p>Dataset Workspace</p>
                </div>
              </div>
              <div className="control-card">
                <label className="control-group">
                  <span>Upload Images</span>
                  <input type="file" multiple accept="image/*" onChange={handleImageUpload} />
                </label>
                <div className="control-group">
                  <span>Active Class</span>
                  <select
                    value={selectedClass}
                    onChange={(e) => setSelectedClass(e.target.value)}
                  >
                    {classOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="control-group class-control">
                  <span>Add Class</span>
                  <div className="inline-control">
                    <input
                      type="text"
                      value={classDraft}
                      onChange={(e) => setClassDraft(e.target.value)}
                      placeholder="new class"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addClassOption();
                        }
                      }}
                    />
                    <button onClick={addClassOption}>Add</button>
                  </div>
                </div>
                <div className="class-chip-row">
                  {classOptions.map((className) => (
                    <div
                      key={className}
                      className={`class-chip ${selectedClass === className ? "active" : ""}`}
                    >
                      <button onClick={() => setSelectedClass(className)}>
                        {className}
                      </button>
                      <button onClick={() => removeClassOption(className)}>×</button>
                    </div>
                  ))}
                </div>
                <div className="control-group">
                  <span>Export Format</span>
                  <select
                    value={exportFormat}
                    onChange={(e) => setExportFormat(e.target.value)}
                  >
                    <option value="coco">COCO JSON</option>
                    <option value="yolo">YOLO</option>
                    <option value="voc">Pascal VOC</option>
                  </select>
                </div>
                <button onClick={downloadAnnotations} disabled={!images.length}>
                  Download Annotations
                </button>
              </div>
            </aside>
            <div className="app">
              <header className="topbar">
                <div>
                  <h2>Image Annotation Tool</h2>
                  <p>Draw bounding boxes and export.</p>
                </div>
                <div className="stats">
                  <span>{images.length} images</span>
                  <span>{totalAnnotations} boxes</span>
                  <span>{classOptions.length} classes</span>
                </div>
              </header>
              <main className="workspace">
                {/* Image List */}
                <aside className="image-list panel">
                  <h2>Images</h2>
                  {images.map((image) => (
                    <button
                      key={image.id}
                      className={image.id === activeImageId ? "active" : ""}
                      onClick={() => setFullscreenImageId(image.id)}
                    >
                      <img src={image.url} alt="" />
                      <strong>{image.fileName}</strong>
                      <span>{image.annotations.length} boxes</span>
                    </button>
                  ))}
                </aside>
                {/* Canvas */}
                <section className="canvas-panel panel">
                  {activeImage && (
                    <div
                      className="annotation-canvas"
                      style={{ position: 'relative', cursor: canvasCursor }}
                      ref={!fullscreenImageId ? canvasRef : null}
                      tabIndex={0}
                      onPointerDown={!fullscreenImageId ? handlePointerDown : undefined}
                      onPointerMove={!fullscreenImageId ? (e) => { handlePointerMove(e); setHoverPoint(readPointerPosition(e)); } : undefined}
                      onPointerUp={!fullscreenImageId ? handlePointerUp : undefined}
                      onPointerLeave={!fullscreenImageId ? (e) => { handlePointerLeave(e); setHoverPoint(null); } : undefined}
                      onPointerCancel={!fullscreenImageId ? handlePointerCancel : undefined}
                    >
                      <img src={activeImage.url} alt="" draggable={false} />
                      <svg className="overlay">
                        {/* pointerEvents: all to allow pointer events to pass through SVG for guidelines */}
                        {activeImage.annotations.map((box) => (
                          <g key={box.id}>
                            <rect
                              x={`${box.x * 100}%`}
                              y={`${box.y * 100}%`}
                              width={`${box.width * 100}%`}
                              height={`${box.height * 100}%`}
                              className="annotation-box"
                            />
                            <text
                              x={`${box.x * 100 + 1}%`}
                              y={`${box.y * 100 + 2}%`}
                            >
                              {box.className}
                            </text>
                          </g>
                        ))}
                                        {/* Crosshair guide lines always visible when pointer is over image (main page) */}
                                        {!fullscreenImageId && hoverPoint && (
                                          <g className="guide-lines">
                                            <line
                                              x1={hoverPoint.x}
                                              y1={0}
                                              x2={hoverPoint.x}
                                              y2={hoverPoint.height}
                                              stroke="#0e7490"
                                              strokeDasharray="4 4"
                                              strokeWidth="1"
                                            />
                                            <line
                                              x1={0}
                                              y1={hoverPoint.y}
                                              x2={hoverPoint.width}
                                              y2={hoverPoint.y}
                                              stroke="#0e7490"
                                              strokeDasharray="4 4"
                                              strokeWidth="1"
                                            />
                                          </g>
                                        )}
                                        {/* Draw preview rectangle if drawing (main page) */}
                                        {!fullscreenImageId && drawStart && drawCurrent && (
                                          <rect
                                            x={Math.min(drawStart.x, drawCurrent.x)}
                                            y={Math.min(drawStart.y, drawCurrent.y)}
                                            width={Math.abs(drawCurrent.x - drawStart.x)}
                                            height={Math.abs(drawCurrent.y - drawStart.y)}
                                            className="annotation-box preview"
                                            style={{ stroke: '#2563eb', strokeDasharray: '4 2', fill: 'none' }}
                                          />
                                        )}
                      </svg>
                    </div>
                  )}
                </section>
                {/* Annotation List */}
                <aside className="annotation-list panel">
                  <h2>Annotations</h2>
                  {activeImage?.annotations.length === 0 && (
                    <div className="panel-empty">No annotations yet.</div>
                  )}
                  {activeImage?.annotations.map((item, index) => (
                    <div key={item.id} className={"annotation-row" + (selectedAnnotationId === item.id ? " selected" : "")}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, padding: 8, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', cursor: 'pointer' }}
                      onClick={() => setSelectedAnnotationId(item.id)}
                    >
                      <span style={{ fontWeight: 500, color: '#1e293b' }}>#{index + 1} <span style={{ color: '#2563eb' }}>{item.className}</span></span>
                      <button style={{ height: 30, borderRadius: 7, background: '#fff', border: '1px solid #e2e8f0', color: '#dc2626', fontWeight: 600, cursor: 'pointer', padding: '0 12px' }} onClick={e => { e.stopPropagation(); removeAnnotation(item.id); }}>Delete</button>
                    </div>
                  ))}
                </aside>
              </main>
            </div>
          </>
        )}
        {/* Fullscreen Modal (shown when modal is open) */}
        {fullscreenImageId && fullscreenImage && (
          <div className="fullscreen-modal">
            <div className="fullscreen-modal-content" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 16px)', maxHeight: 'calc(100vh - 16px)', width: 'calc(100vw - 16px)', maxWidth: 'calc(100vw - 16px)', borderRadius: 8, padding: 0, margin: 8 }}>
              {/* Modal header and class selection */}
              <div style={{ padding: '2px 8px 0 8px', background: 'transparent', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 16 }}>
                <button
                  className="fullscreen-back-btn"
                  style={{ position: 'static', margin: '8px 0', padding: '6px 18px', borderRadius: 6, fontSize: '1.05rem', border: '1px solid #bbb', color: '#222', boxShadow: 'none', cursor: 'pointer', transition: 'background 0.2s' }}
                  onClick={() => setFullscreenImageId(null)}
                >
                  ← Back
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>Class:</span>
                  <select
                    value={selectedClass}
                    onChange={(e) => setSelectedClass(e.target.value)}
                  >
                    {classOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
                {/* Annotation area with zoom and annotation controls */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '0 4px 2px 4px', overflow: 'auto', minHeight: 0 }}>
                  <div className="zoom-controls" style={{ marginBottom: 8 }}>
                    <button type="button" onClick={() => setZoom((z) => Math.max(25, z - 10))}>-</button>
                    <input type="range" min="25" max="1000" value={zoom} onChange={(e) => setClampedZoom(Number(e.target.value))} />
                    <button type="button" onClick={() => setZoom((z) => Math.min(1000, z + 10))}>+</button>
                    <button type="button" onClick={() => setClampedZoom(100)}>Reset</button>
                    <span>{zoom}%</span>
                  </div>
                  {/* Annotation canvas with pointer events for drawing (modal) */}
                  <div
                    className="annotation-canvas"
                    style={{ position: 'relative', cursor: canvasCursor, display: 'inline-block' }}
                    ref={fullscreenImageId ? canvasRef : null}
                    tabIndex={0}
                    onPointerDown={fullscreenImageId ? handlePointerDown : undefined}
                    onPointerMove={fullscreenImageId ? (e) => { handlePointerMove(e); setHoverPoint(readPointerPosition(e)); } : undefined}
                    onPointerUp={fullscreenImageId ? handlePointerUp : undefined}
                    onPointerLeave={fullscreenImageId ? (e) => { handlePointerLeave(e); setHoverPoint(null); } : undefined}
                    onPointerCancel={fullscreenImageId ? handlePointerCancel : undefined}
                  >
                    <img
                      ref={modalImageRef}
                      src={fullscreenImage.url}
                      alt=""
                      draggable={false}
                      style={{ width: `${zoom}%`, height: 'auto', objectFit: 'contain', background: '#fff', borderRadius: 8, boxShadow: '0 1px 4px rgba(0,0,0,0.04)', display: 'block', position: 'relative', zIndex: 1 }}
                      onLoad={updateImageMeta}
                    />
                    {/* SVG overlay absolutely positioned over the image, sized to match the rendered image */}
                    <svg
                      className="overlay"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: modalImageRef.current ? `${modalImageRef.current.offsetWidth}px` : '100%',
                        height: modalImageRef.current ? `${modalImageRef.current.offsetHeight}px` : '100%',
                        pointerEvents: 'all',
                        zIndex: 2,
                      }}
                      width={modalImageRef.current ? modalImageRef.current.offsetWidth : undefined}
                      height={modalImageRef.current ? modalImageRef.current.offsetHeight : undefined}
                    >
                      {fullscreenImage.annotations.map((box) => (
                        <g key={box.id}>
                          <rect
                            x={modalImageRef.current ? box.x * modalImageRef.current.offsetWidth : 0}
                            y={modalImageRef.current ? box.y * modalImageRef.current.offsetHeight : 0}
                            width={modalImageRef.current ? box.width * modalImageRef.current.offsetWidth : 0}
                            height={modalImageRef.current ? box.height * modalImageRef.current.offsetHeight : 0}
                            className="annotation-box"
                          />
                          <text
                            x={modalImageRef.current ? box.x * modalImageRef.current.offsetWidth + 4 : 0}
                            y={modalImageRef.current ? box.y * modalImageRef.current.offsetHeight + 14 : 0}
                            className="annotation-label"
                          >
                            {box.className}
                          </text>
                        </g>
                      ))}
                      {/* Crosshair guide lines always visible when pointer is over image (modal) */}
                      {modalImageRef.current && hoverPoint && (
                        <g className="guide-lines">
                          <line
                            x1={hoverPoint.x}
                            y1={0}
                            x2={hoverPoint.x}
                            y2={modalImageRef.current.offsetHeight}
                            stroke="#0e7490"
                            strokeDasharray="4 4"
                            strokeWidth="1"
                          />
                          <line
                            x1={0}
                            y1={hoverPoint.y}
                            x2={modalImageRef.current.offsetWidth}
                            y2={hoverPoint.y}
                            stroke="#0e7490"
                            strokeDasharray="4 4"
                            strokeWidth="1"
                          />
                        </g>
                      )}
                      {/* Draw preview rectangle if drawing (modal) */}
                      {drawStart && drawCurrent && modalImageRef.current && (() => {
                        const x = Math.min(drawStart.x, drawCurrent.x);
                        const y = Math.min(drawStart.y, drawCurrent.y);
                        const width = Math.abs(drawCurrent.x - drawStart.x);
                        const height = Math.abs(drawCurrent.y - drawStart.y);
                        return (
                          <rect
                            x={x}
                            y={y}
                            width={width}
                            height={height}
                            className="annotation-box preview"
                            style={{ stroke: '#2563eb', strokeDasharray: '4 2', fill: 'none' }}
                          />
                        );
                      })()}
                    </svg>
                  </div>
                </div>
                {/* Annotation List in Modal */}
                <aside className="annotation-list panel" style={{ minWidth: 220, maxWidth: 320, marginLeft: 12, flex: '0 0 260px', overflowY: 'auto' }}>
                  <h2>Annotations</h2>
                  {fullscreenImage.annotations.length === 0 && (
                    <div className="panel-empty">No annotations yet.</div>
                  )}
                  {fullscreenImage.annotations.map((item, index) => (
                    <div key={item.id} className={"annotation-row" + (selectedAnnotationId === item.id ? " selected" : "")}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, padding: 8, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc', cursor: 'pointer' }}
                      onClick={() => setSelectedAnnotationId(item.id)}
                    >
                      <span style={{ fontWeight: 500, color: '#1e293b' }}>#{index + 1} <span style={{ color: '#2563eb' }}>{item.className}</span></span>
                      <button style={{ height: 30, borderRadius: 7, background: '#fff', border: '1px solid #e2e8f0', color: '#dc2626', fontWeight: 600, cursor: 'pointer', padding: '0 12px' }} onClick={e => { e.stopPropagation(); removeAnnotation(item.id); }}>Delete</button>
                    </div>
                  ))}
                </aside>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

export default App;


