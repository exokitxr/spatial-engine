const localVector = new THREE.Vector3();
const localVector2 = new THREE.Vector3();
const localVector2D = new THREE.Vector2();
const localQuaternion = new THREE.Quaternion();
const localRaycaster = new THREE.Raycaster();

const _getNextPowerOf2 = n => Math.pow(2, Math.ceil(Math.log(n)/Math.log(2)));
const _makePromise = () => {
  let accept, reject;
  const p = new Promise((a, r) => {
    accept = a;
    reject = r;
  });
  p.accept = accept;
  p.reject = reject;
  return p;
};

export class XRRaycaster {
  constructor({width = 512, height = 512, fov = 60, aspect = 1, depth = 3, near = 0.1, far = 300, renderer = new THREE.WebGLRenderer(), onRender = (target, camera) => {}} = {}) {
    this.width = width;
    this.height = height;
    this.renderer = renderer;

    const cameraHeight = depth * 2 * Math.atan(fov*(Math.PI/180)/2);
    const cameraWidth = cameraHeight * aspect;
    const camera = new THREE.OrthographicCamera(
      cameraWidth / -2, cameraWidth / 2,
      cameraHeight / 2, cameraHeight / -2,
      near, far
    );
    this.camera = camera;

    const colorTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    colorTarget.fresh = false;
    colorTarget.freshDepthBuf = false;
    colorTarget.freshCoordBuf = false;
    const colorTargetDepthBuf = new Float32Array(width*height*4); // encoded z depths
    this.colorTargetDepthBuf = colorTargetDepthBuf;
    const colorTargetCoordBuf = new Float32Array(width*height*3); // decoded xyz points
    this.colorTargetCoordBuf = colorTargetCoordBuf;
    colorTarget.updateView = (p, q) => {
      const position = localVector.fromArray(p);
      const quaternion = localQuaternion.fromArray(q);

      if (!camera.position.equals(position) || !camera.quaternion.equals(quaternion)) {
        camera.position.copy(position);
        camera.quaternion.copy(quaternion);
        camera.updateMatrixWorld();
        colorTarget.fresh = false;
      }
    };
    colorTarget.updateTexture = () => {
      if (!colorTarget.fresh) {
        onRender({
          target: colorTarget,
          near,
          far,
          matrixWorld: camera.matrixWorld.toArray(),
          projectionMatrix: camera.projectionMatrix.toArray(),
        });
        colorTarget.fresh = true;
        colorTarget.freshDepthBuf = false;
      }
    };
    colorTarget.updateDepthBuffer = () => {
      if (!colorTarget.freshDepthBuf) {
        renderer.readRenderTargetPixels(colorTarget, 0, 0, width, height, colorTargetDepthBuf, 0);
        colorTarget.freshDepthBuf = true;
        colorTarget.freshCoordBuf = false;
      }
    };
    const cameraOrigins = (() => {
      const origins = new Float32Array(width*height*3);
      let index = 0;
      for (let y = height-1; y >= 0; y--) {
        for (let x = 0; x < width; x++) {
          const xFactor = x / width;
          const yFactor = y / height;
          localVector.set(xFactor * 2 - 1, -yFactor * 2 + 1, (camera.near + camera.far) / (camera.near - camera.far))
            .applyMatrix4(camera.projectionMatrixInverse)
            .toArray(origins, index);
          index += 3;
        }
      }
      // console.log('use camera matrix world', camera.matrixWorld.toArray().join(','));
      return origins;
    })();
    if (!window.cameraOrigins) {
      window.cameraOrigins = cameraOrigins;
      window.lol1 = width;
      window.lol2 = height;
    }
    colorTarget.updatePointCloudBuffer = () => {
      if (!colorTarget.freshCoordBuf) {
        let index3 = 0;
        let index4 = 0;
        for (let y = height-1; y >= 0; y--) {
          for (let x = 0; x < width; x++) {
            const z = XRRaycaster.decodePixelDepth(colorTargetDepthBuf, index4);

            localVector.fromArray(cameraOrigins, index3)
              .applyMatrix4(camera.matrixWorld)
              .add(localVector2.set(0, 0, -1).transformDirection(camera.matrixWorld).multiplyScalar(z))
              .toArray(colorTargetCoordBuf, index3);
            index3 += 3;
            index4 += 4;
          }
        }

        colorTarget.freshCoordBuf = true;
      }
    };
    this.colorTarget = colorTarget;
  }
  getDepthTexture() {
    return this.colorTarget.texture;
  }
  getDepthBuffer() {
    return this.colorTargetDepthBuf;
  }
  getPointCloudBuffer() {
    return this.colorTargetCoordBuf;
  }
  async raycast(camera, xFactor, yFactor) {
    if (xFactor >= 0 && xFactor <= 1 && yFactor >= 0 && yFactor <= 1) {
      localRaycaster.setFromCamera(localVector2D.set(xFactor * 2 - 1, -yFactor * 2 + 1), camera);

      const p = localRaycaster.ray.origin.toArray();
      const q = localQuaternion.setFromUnitVectors(localVector.set(0, 0, -1), localRaycaster.ray.direction).toArray();
      this.updateView(p, q);
      this.updateTexture();
      await XRRaycaster.nextFrame();
      this.updateDepthBuffer();

      const z = XRRaycaster.decodePixelDepth(this.colorTargetDepthBuf, 0);
      return localVector.fromArray(p)
        .add(localVector2.set(0, 0, -1).applyQuaternion(localQuaternion.fromArray(q)).multiplyScalar(z))
        .toArray();
    } else {
      return null;
    }
  }
  updateView(p, q) {
    this.colorTarget.updateView(p, q);
  }
  updateTexture() {
    this.colorTarget.updateTexture();
  }
  updateDepthBuffer() {
    this.colorTarget.updateDepthBuffer();
  }
  updatePointCloudBuffer() {
    this.colorTarget.updatePointCloudBuffer();
  }
  render() {
    this.colorTarget.fresh = false;
  }
  static decodePixelDepth(rgba, i) {
    return rgba[i] +
      rgba[i+1] * 255.0 +
      rgba[i+2] * 255.0*255.0 +
      rgba[i+3] * 255.0*255.0*255.0;
  }
  static get decodePixelDepthGLSL() {
    return `
      float decodePixelDepth(vec4 rgba) {
        return dot(rgba, vec4(1.0, 255.0, 255.0*255.0, 255.0*255.0*255.0));
      }
    `;
  }
  static nextFrame() {
    return new Promise((accept, reject) => {
      requestAnimationFrame(accept);
    });
  }
}
export class XRChunk extends EventTarget {
  constructor(x, y, z) {
    super();

    this.object = new THREE.Object3D();
    this.object.position.set(x, y, z);
  }
  getCenter(v = new THREE.Vector3()) {
    return v.copy(this.object.position).add(new THREE.Vector3(0.5, 0.5, 0.5));
  }
}
export class XRChunker extends EventTarget {
  constructor() {
    super();

    this.chunks = [];
    this.running = false;
    this.arrayBuffer = new ArrayBuffer(2*1024*1024);

    this.worker = (() => {
      let cbs = [];
      const worker = new Worker('mc-worker.js');
      worker.onmessage = e => {
        const {data} = e;
        const {error, result} = data;
        cbs.shift()(error, result);
      };
      worker.onerror = err => {
        console.warn(err);
      };
      worker.request = (req, transfers) => new Promise((accept, reject) => {
        worker.postMessage(req, transfers);

        cbs.push((err, result) => {
          if (!err) {
            accept(result);
          } else {
            reject(err);
          }
        });
      });
      return worker;
    })();
  }
  getChunkAt(x, y, z) {
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const dx = x - chunk.object.position.x;
      const dy = y - chunk.object.position.y;
      const dz = z - chunk.object.position.z;
      if (dx >= 0 && dx < 1 && dy >= 0 && dy < 1 && dz >= 0 && dz < 1) {
        return chunk;
      }
    }
    return null;
  }
  updateTransform(p, q, s) {
    const position = localVector.fromArray(p);
    const quaternion = localQuaternion.fromArray(q);
    const scale = localVector2.fromArray(s);

    const _floorVector = v => new THREE.Vector3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z));
    const cameraCenter = _floorVector(position).add(new THREE.Vector3(0.5, 0.5, 0.5));

    const neededCoords = [];
    const _addNeededCoord = (x, y, z) => {
      const c = _floorVector(cameraCenter.clone().add(new THREE.Vector3(x, y, z).applyQuaternion(quaternion)));
      if (!neededCoords.some(c2 => c2.equals(c))) {
        neededCoords.push(c);
      }
    }
    for (let z = 0; z >= -scale.z/2; z--) {
      _addNeededCoord(0, 0, z);
    }
    for (let z = -scale.z/2; z <= scale.z/2; z+=0.5) {
      for (let x = -scale.x/2; x <= scale.x/2; x+=0.5) {
        for (let y = -scale.y/2; y <= scale.y/2; y+=0.5) {
          _addNeededCoord(x, y, z);
        }
      }
    }
    for (let z = scale.z/2; z >= -scale.z/2; z-=0.5) {
      for (let x = scale.x/2; x >= -scale.x/2; x-=0.5) {
        for (let y = scale.y/2; y >= -scale.y/2; y-=0.5) {
          _addNeededCoord(x, y, z);
        }
      }
    }

    const missingChunkCoords = neededCoords.filter(c => !this.getChunkAt(c.x, c.y, c.z));
    const outrangedChunks = this.chunks.filter(chunk => !neededCoords.some(coord => coord.equals(chunk.object.position)));
    for (let i = 0; i < outrangedChunks.length; i++) {
      const chunk = outrangedChunks[i];
      this.chunks.splice(this.chunks.indexOf(chunk), 1);
      this.dispatchEvent(new MessageEvent('removechunk', {data: chunk}));
    }
    for (let i = 0; i < missingChunkCoords.length; i++) {
      const coord = missingChunkCoords[i];
      const chunk = new XRChunk(coord.x, coord.y, coord.z);
      this.chunks.push(chunk);
      this.dispatchEvent(new MessageEvent('addchunk', {data: chunk}));
    }
  }
  async updateMesh(getPointCloud) {
    if (!this.running) {
      this.running = true;

      const {width, voxelSize, marchCubesTexSize, pointCloudBuffer} = await getPointCloud();
      const marchCubesTexTriangleSize = _getNextPowerOf2(Math.sqrt(marchCubesTexSize));
      const marchCubesTexSquares = marchCubesTexSize/marchCubesTexTriangleSize;
      const chunks = this.chunks.slice();
      const chunkCoords = chunks.map(chunk => chunk.object.position.toArray());
      const res = await this.worker.request({
        method: 'computeGeometry',
        chunkCoords,
        colorTargetCoordBuf: pointCloudBuffer,
        colorTargetSize: width,
        voxelSize,
        marchCubesTexSize,
        marchCubesTexSquares,
        marchCubesTexTriangleSize,
        arrayBuffer: this.arrayBuffer,
      }, [this.arrayBuffer]);
      const {potentialsArray, positionsArray, barycentricsArray, uvsArray, uvs2Array, arrayBuffer, size} = res;
      this.arrayBuffer = arrayBuffer;
      if (size > arrayBuffer.byteLength) {
        throw new Error(`geometry buffer overflow: have ${arrayBuffer.byteLength}, need ${size}`);
      }

      for (let i = 0; i < chunks.length; i++) {

        chunks[i].dispatchEvent(new MessageEvent('update', {
          data: {
            potentials: potentialsArray[i],
            positions: positionsArray[i],
            barycentrics: barycentricsArray[i],
            uvs: uvsArray[i],
            uvs2: uvs2Array[i],
          },
        }));
      }
      this.updatePromise = _makePromise();
      await this.updatePromise;

      this.running = false;
    }
  }
  render() {
    if (this.updatePromise) {
      this.updatePromise.accept();
      this.updatePromise = null;
    }
  }
}