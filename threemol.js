/**
 * ThreeMol — drop-in renderer Three.js para Chem&SymUAH
 * Reemplaza $3Dmol.createViewer() con calidad visual superior:
 *   - MeshPhongMaterial con especular (esferas brillantes)
 *   - Iluminación direccional + ambiente
 *   - OrbitControls (rotate/zoom/pan)
 *   - Etiquetas HTML (CSS overlay, texto nítido)
 *
 * API compatible con 3Dmol.js (mismos métodos usados en el proyecto):
 *   addSphere, addCylinder, addArrow, addLabel, addCustom,
 *   removeAllShapes, removeAllLabels, zoomTo, zoom, render,
 *   getView, setView, clear
 */
(function (global) {
    'use strict';

    /* ------------------------------------------------------------------ */
    /*  Helpers internos                                                    */
    /* ------------------------------------------------------------------ */

    function hexToThreeColor(c) {
        // Acepta 0xRRGGBB (número) o '#rrggbb' (cadena)
        if (typeof c === 'number') return new THREE.Color(c);
        return new THREE.Color(c);
    }

    /** Orienta un objeto Three.js cuyo eje local Y apunta de sv a ev */
    function orientAlongAxis(obj, sv, ev) {
        var dir = ev.clone().sub(sv).normalize();
        var quat = new THREE.Quaternion();
        // setFromUnitVectors maneja correctamente todos los casos:
        // paralelo (+Y→+Y = identidad), antiparalelo (+Y→-Y = 180°), y general.
        // El caso especial anterior era incorrecto para dir≈+Y.
        quat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        obj.setRotationFromQuaternion(quat);
    }

    /** Libera geometría y material de un objeto (recursivo en Groups) */
    function disposeObject(obj) {
        if (!obj) return;
        if (obj.children) {
            obj.children.forEach(function (c) { disposeObject(c); });
        }
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(function (m) { m.dispose(); });
            } else {
                obj.material.dispose();
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Constructor                                                         */
    /* ------------------------------------------------------------------ */

    function ThreeMolViewer(container, options) {
        options = options || {};

        this._container = container;
        this._shapes    = [];   // THREE.Object3D meshes/groups
        this._labels    = [];   // {el: HTMLElement, pos: THREE.Vector3}
        this._animId    = null;

        /* --- tamaño inicial ------------------------------------------- */
        var w = container.clientWidth  || 400;
        var h = container.clientHeight || 400;

        /* --- escena ----------------------------------------------------- */
        this._scene = new THREE.Scene();
        var bg = (options.backgroundColor !== undefined)
            ? options.backgroundColor : 0xffffff;
        this._scene.background = hexToThreeColor(bg);

        /* --- cámara ----------------------------------------------------- */
        this._camera = new THREE.PerspectiveCamera(45, w / h, 0.05, 500);
        this._camera.position.set(0, 0, 12);

        /* --- renderer --------------------------------------------------- */
        this._renderer = new THREE.WebGLRenderer({
            antialias : options.antialias !== false,
            alpha     : false
        });
        this._renderer.setSize(w, h);
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._renderer.sortObjects = true;   // orden correcto para transparencias

        var canvas = this._renderer.domElement;
        canvas.style.cssText = 'display:block;width:100%;height:100%;';
        container.appendChild(canvas);

        /* --- overlay de etiquetas --------------------------------------- */
        this._labelEl = document.createElement('div');
        this._labelEl.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'pointer-events:none;overflow:hidden;';
        container.appendChild(this._labelEl);

        /* --- luces ------------------------------------------------------ */
        // Luz ambiente suave (iluminación base)
        var ambient = new THREE.AmbientLight(0xffffff, 0.45);
        this._scene.add(ambient);

        // Luz principal: arriba-izquierda-frente (crea el highlight brillante)
        var dir1 = new THREE.DirectionalLight(0xffffff, 0.85);
        dir1.position.set(2, 3, 4);
        this._scene.add(dir1);

        // Luz de relleno: dirección opuesta, más suave
        var dir2 = new THREE.DirectionalLight(0xffffff, 0.25);
        dir2.position.set(-3, -1, -2);
        this._scene.add(dir2);

        /* --- OrbitControls ---------------------------------------------- */
        if (typeof THREE.OrbitControls !== 'undefined') {
            this._controls = new THREE.OrbitControls(
                this._camera, this._renderer.domElement
            );
            this._controls.enableDamping  = true;
            this._controls.dampingFactor  = 0.08;
            this._controls.minDistance    = 0.5;
            this._controls.maxDistance    = 100;
            this._controls.target.set(0, 0, 0);
        } else {
            this._controls = null;
        }

        /* --- ResizeObserver -------------------------------------------- */
        var self = this;
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObs = new ResizeObserver(function () {
                self._onResize();
            });
            this._resizeObs.observe(container);
        } else {
            this._resizeObs = null;
        }

        /* --- bucle de render ------------------------------------------- */
        this._startLoop();
    }

    /* ------------------------------------------------------------------ */
    /*  Loop interno                                                        */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype._startLoop = function () {
        var self = this;
        function loop() {
            // Si el canvas fue eliminado del DOM (innerHTML=''), parar el loop
            if (!self._renderer.domElement.isConnected) {
                cancelAnimationFrame(self._animId);
                self._animId = null;
                return;
            }
            self._animId = requestAnimationFrame(loop);
            if (self._controls) self._controls.update();
            self._doRender();
        }
        loop();
    };

    ThreeMolViewer.prototype._doRender = function () {
        this._renderer.render(this._scene, this._camera);
        this._updateLabels();
    };

    ThreeMolViewer.prototype._onResize = function () {
        var w = this._container.clientWidth;
        var h = this._container.clientHeight;
        if (w > 0 && h > 0) {
            this._camera.aspect = w / h;
            this._camera.updateProjectionMatrix();
            this._renderer.setSize(w, h);
        }
    };

    /** Proyecta posiciones 3D a pantalla para las etiquetas HTML */
    ThreeMolViewer.prototype._updateLabels = function () {
        var w = this._container.clientWidth;
        var h = this._container.clientHeight;
        if (!w || !h) return;
        var vec = new THREE.Vector3();
        for (var i = 0; i < this._labels.length; i++) {
            var lbl = this._labels[i];
            vec.copy(lbl.pos).project(this._camera);
            var x = (vec.x *  0.5 + 0.5) * w;
            var y = (vec.y * -0.5 + 0.5) * h;
            lbl.el.style.left = x + 'px';
            lbl.el.style.top  = y + 'px';
            // Ocultar si está detrás de la cámara
            lbl.el.style.display = (vec.z < 1.0) ? 'block' : 'none';
        }
    };

    /* ------------------------------------------------------------------ */
    /*  addSphere                                                           */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.addSphere = function (opts) {
        var color   = (opts.color   !== undefined) ? opts.color   : 0xcccccc;
        var opacity = (opts.opacity !== undefined) ? opts.opacity : 1.0;
        var radius  = opts.radius || 0.3;

        var geo = new THREE.SphereGeometry(radius, 32, 24);
        var mat = new THREE.MeshPhongMaterial({
            color     : hexToThreeColor(color),
            specular  : new THREE.Color(0x666666),
            shininess : 90,
            transparent : opacity < 1,
            opacity     : opacity,
            depthWrite  : opacity >= 1
        });

        var mesh = new THREE.Mesh(geo, mat);
        var c = opts.center;
        mesh.position.set(c.x, c.y, c.z);
        this._scene.add(mesh);
        this._shapes.push(mesh);
        return mesh;
    };

    /* ------------------------------------------------------------------ */
    /*  addCylinder                                                         */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.addCylinder = function (opts) {
        var color   = (opts.color   !== undefined) ? opts.color   : 0x888888;
        var opacity = (opts.opacity !== undefined) ? opts.opacity : 1.0;
        var radius  = opts.radius || 0.05;

        var s  = opts.start, e = opts.end;
        var sv = new THREE.Vector3(s.x, s.y, s.z);
        var ev = new THREE.Vector3(e.x, e.y, e.z);
        var length = sv.distanceTo(ev);
        if (length < 0.001) return null;

        var geo = new THREE.CylinderGeometry(radius, radius, length, 16, 1, false);
        var mat = new THREE.MeshPhongMaterial({
            color     : hexToThreeColor(color),
            specular  : new THREE.Color(0x333333),
            shininess : 50,
            transparent : opacity < 1,
            opacity     : opacity,
            depthWrite  : opacity >= 1
        });

        var mesh = new THREE.Mesh(geo, mat);
        // Posicionar en el punto medio
        mesh.position.copy(sv.clone().add(ev).multiplyScalar(0.5));
        orientAlongAxis(mesh, sv, ev);

        this._scene.add(mesh);
        this._shapes.push(mesh);
        return mesh;
    };

    /* ------------------------------------------------------------------ */
    /*  addArrow                                                            */
    /* ------------------------------------------------------------------ */
    /*  En el código, addArrow se usa para la punta de flecha de los ejes. */
    /*  start=base del cono, end=punta. radiusRatio=multiplicador del radio.*/

    ThreeMolViewer.prototype.addArrow = function (opts) {
        var color   = (opts.color !== undefined) ? opts.color : 0x888888;
        var radius  = opts.radius || 0.04;
        var ratio   = opts.radiusRatio || 3;

        var s  = opts.start, e = opts.end;
        var sv = new THREE.Vector3(s.x, s.y, s.z);
        var ev = new THREE.Vector3(e.x, e.y, e.z);
        var dir    = ev.clone().sub(sv);
        var length = dir.length();
        if (length < 0.001) return null;

        var coneRadius  = radius * ratio;
        var coneHeight  = length * 0.6;     // 60% longitud = cono
        var shaftLength = length - coneHeight;

        var group = new THREE.Group();

        var mat = new THREE.MeshPhongMaterial({
            color     : hexToThreeColor(color),
            specular  : new THREE.Color(0x333333),
            shininess : 50
        });

        // Cilindro (shaft)
        if (shaftLength > 0.001) {
            var shaftGeo = new THREE.CylinderGeometry(
                radius, radius, shaftLength, 12, 1, false
            );
            var shaft = new THREE.Mesh(shaftGeo, mat.clone());
            shaft.position.set(0, shaftLength / 2, 0);
            group.add(shaft);
        }

        // Cono (cabeza de flecha)
        var coneGeo = new THREE.ConeGeometry(coneRadius, coneHeight, 16);
        var cone    = new THREE.Mesh(coneGeo, mat.clone());
        cone.position.set(0, shaftLength + coneHeight / 2, 0);
        group.add(cone);

        // Orientar el grupo desde sv en dirección ev
        group.position.copy(sv);
        orientAlongAxis(group, new THREE.Vector3(0,0,0), dir.normalize());

        this._scene.add(group);
        this._shapes.push(group);
        return group;
    };

    /* ------------------------------------------------------------------ */
    /*  addLabel                                                            */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.addLabel = function (text, opts) {
        var pos       = opts.position;
        var fontSize  = opts.fontSize  || 12;
        var fontColor = opts.fontColor || '#000000';
        var showBg    = opts.showBackground !== false;
        var bgColor   = (opts.backgroundColor && opts.backgroundColor !== 'transparent')
            ? opts.backgroundColor : null;

        var el = document.createElement('div');
        el.textContent = text;

        var css = [
            'position:absolute',
            'transform:translate(-50%,-50%)',
            'font-size:' + fontSize + 'px',
            'color:' + fontColor,
            'font-family:Arial,Helvetica,sans-serif',
            'font-weight:bold',
            'pointer-events:none',
            'white-space:nowrap',
            'user-select:none',
            'line-height:1'
        ];
        if (showBg && bgColor) {
            css.push('background:' + bgColor);
            css.push('padding:1px 4px');
            css.push('border-radius:3px');
        }
        el.style.cssText = css.join(';') + ';';

        this._labelEl.appendChild(el);

        var lbl = { el: el, pos: new THREE.Vector3(pos.x, pos.y, pos.z) };
        this._labels.push(lbl);
        return lbl;
    };

    /* ------------------------------------------------------------------ */
    /*  addCustom  (planos semitransparentes de simetría)                  */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.addCustom = function (opts) {
        var color   = (opts.color   !== undefined) ? opts.color   : 0x44ffdd;
        var opacity = (opts.opacity !== undefined) ? opts.opacity : 0.3;

        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position',
            new THREE.Float32BufferAttribute(opts.vertexArr, 3));
        geo.setAttribute('normal',
            new THREE.Float32BufferAttribute(opts.normalArr, 3));
        geo.setIndex(opts.faceArr);

        var mat = new THREE.MeshPhongMaterial({
            color       : hexToThreeColor(color),
            specular    : new THREE.Color(0x111111),
            shininess   : 20,
            transparent : true,
            opacity     : opacity,
            side        : THREE.DoubleSide,
            depthWrite  : false
        });

        var mesh = new THREE.Mesh(geo, mat);
        this._scene.add(mesh);
        this._shapes.push(mesh);
        return mesh;
    };

    /* ------------------------------------------------------------------ */
    /*  Limpieza de formas y etiquetas                                     */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.removeAllShapes = function () {
        for (var i = 0; i < this._shapes.length; i++) {
            this._scene.remove(this._shapes[i]);
            disposeObject(this._shapes[i]);
        }
        this._shapes = [];
    };

    ThreeMolViewer.prototype.removeAllLabels = function () {
        for (var i = 0; i < this._labels.length; i++) {
            if (this._labels[i].el.parentNode) {
                this._labels[i].el.parentNode.removeChild(this._labels[i].el);
            }
        }
        this._labels = [];
    };

    /* ------------------------------------------------------------------ */
    /*  Cámara: zoomTo, zoom                                               */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.zoomTo = function () {
        if (this._shapes.length === 0) return;

        var box = new THREE.Box3();
        for (var i = 0; i < this._shapes.length; i++) {
            try { box.expandByObject(this._shapes[i]); } catch (e) {}
        }
        if (box.isEmpty()) return;

        var center = box.getCenter(new THREE.Vector3());
        var size   = box.getSize(new THREE.Vector3());
        var maxDim = Math.max(size.x, size.y, size.z);
        var fov    = this._camera.fov * Math.PI / 180;
        var dist   = (maxDim / 2) / Math.tan(fov / 2) * 1.6;

        if (this._controls) {
            this._controls.target.copy(center);
            this._controls.update();
        }
        this._camera.position.copy(center)
            .add(new THREE.Vector3(0, 0, dist));
        this._camera.lookAt(center);
    };

    ThreeMolViewer.prototype.zoom = function (factor) {
        var target = this._controls
            ? this._controls.target.clone()
            : new THREE.Vector3(0, 0, 0);
        var dir = this._camera.position.clone().sub(target);
        this._camera.position.copy(
            target.clone().add(dir.multiplyScalar(1.0 / factor))
        );
        if (this._controls) this._controls.update();
    };

    /* ------------------------------------------------------------------ */
    /*  render  (explícito; el loop también renderiza automáticamente)     */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.render = function () {
        this._doRender();
    };

    /* ------------------------------------------------------------------ */
    /*  getView / setView  (preservar zoom/orientación del usuario)        */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.getView = function () {
        return {
            camPos  : this._camera.position.clone(),
            camQuat : this._camera.quaternion.clone(),
            target  : this._controls
                ? this._controls.target.clone()
                : new THREE.Vector3(0, 0, 0)
        };
    };

    ThreeMolViewer.prototype.setView = function (view) {
        if (!view) return;
        this._camera.position.copy(view.camPos);
        this._camera.quaternion.copy(view.camQuat);
        if (this._controls && view.target) {
            this._controls.target.copy(view.target);
            this._controls.update();
        }
        this._doRender();
    };

    /* ------------------------------------------------------------------ */
    /*  clear  (llamado en showScreen para limpiar recursos)               */
    /* ------------------------------------------------------------------ */

    ThreeMolViewer.prototype.clear = function () {
        // Cancelar loop
        if (this._animId) {
            cancelAnimationFrame(this._animId);
            this._animId = null;
        }
        // Desconectar observer
        if (this._resizeObs) {
            this._resizeObs.disconnect();
            this._resizeObs = null;
        }
        // Limpiar controles
        if (this._controls) {
            this._controls.dispose();
            this._controls = null;
        }
        // Eliminar formas y etiquetas
        this.removeAllShapes();
        this.removeAllLabels();
        // Limpiar renderer
        this._renderer.dispose();
        if (this._renderer.domElement.parentNode) {
            this._renderer.domElement.parentNode.removeChild(
                this._renderer.domElement
            );
        }
        if (this._labelEl.parentNode) {
            this._labelEl.parentNode.removeChild(this._labelEl);
        }
    };

    /* ------------------------------------------------------------------ */
    /*  API pública: $3Dmol.createViewer() — compatible con el código      */
    /*  existente sin ningún cambio adicional                              */
    /* ------------------------------------------------------------------ */

    global.$3Dmol = {
        createViewer: function (div, options) {
            return new ThreeMolViewer(div, options || {});
        }
    };

}(window));
